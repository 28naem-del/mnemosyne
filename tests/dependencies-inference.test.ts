import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime, type SkillValidation } from '../src/runtime/index.js';
import { createPremiseGuard, inferDependencies, proposalDigest, reviewDependency, type InferredDependency } from '../src/dependencies/index.js';

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });

function world() {
  let tick = Date.parse('2026-10-28T00:00:00.000Z');
  const now = () => new Date(tick += 1000);
  const db = createLocalMemory({ path: ':memory:', agentId: 'alice', workspaceId: 'project', now, retrieval: 'lexical' }); opened.push(db);
  const runtime = new MemoryRuntime(db, { now });
  const fact = (text: string, extra: Partial<Parameters<LocalMemory['store']>[0]> = {}) => db.store({ text, kind: 'fact', trust: 'observed', source: { uri: `test:${text.slice(0, 12)}` }, ...extra });
  const procedure = (text: string, dependencies: string[] = []) => db.store({ text, kind: 'procedure', trust: 'observed', source: { uri: `test:${text.slice(0, 12)}` }, dependencies });
  let serial = 0;
  /** One task: retrieve, act on `used`, judge by trace outcome or by a verifier on the retrieval. */
  const task = (retrieved: MemoryRecord[], used: MemoryRecord[], success: boolean, judge: 'trace' | 'verifier' = 'trace') => {
    const taskId = `task-${++serial}`;
    db.recall({ query: retrieved.map(record => record.text).join(' '), limit: 10 });
    const evidence = `Synthetic evidence for ${taskId}.`;
    runtime.recordTrace({ taskId, query: 'synthetic', retrievedIds: retrieved.map(record => record.id), usedIds: used.map(record => record.id), ...(judge === 'trace' ? { outcome: { success, evidence, verifier: 'harness' } } : {}) });
    if (judge === 'verifier') db.recordRetrievalOutcome({ taskId, success, verifier: 'harness', evidence });
    return taskId;
  };
  return { db, runtime, now, fact, procedure, task };
}

/** Background tasks that use no premise, so base rates are realistic. */
function background(w: ReturnType<typeof world>, count = 6) {
  const other = w.procedure('Rotate the service credentials with the vault tool.');
  const vault = w.fact('The vault tool requires a hardware key.');
  for (let index = 0; index < count; index++) w.task([other, vault], [other], true, index % 2 ? 'trace' : 'verifier');
  return { other, vault };
}

describe('inferDependencies (co-use-success-v1)', () => {
  it('proposes a premise used in successful tasks and rejects retrieval-only, failed-only and single co-use decoys', () => {
    const w = world();
    const deploy = w.procedure('Deploy the web service with the blue green script.');
    const region = w.fact('Production runs in the eu-west-1 region.');
    const retrievedOnly = w.fact('The staging database is read-only on Fridays.');
    const failedOnly = w.fact('Deploys need the legacy load balancer.');
    const once = w.fact('The status page is updated after each deploy.');
    background(w);
    w.task([deploy, region, retrievedOnly], [deploy, region], true);
    w.task([deploy, region, retrievedOnly, failedOnly], [deploy, region], true, 'verifier');
    w.task([deploy, region, retrievedOnly, once], [deploy, region, once], true);
    w.task([deploy, failedOnly], [deploy, failedOnly], false, 'verifier');
    w.task([deploy, failedOnly, region], [deploy, failedOnly, region], false, 'verifier');

    const result = inferDependencies(w.db);
    expect(result.proposals.map(proposal => [proposal.from, proposal.to])).toEqual([[deploy.id, region.id]]);
    const [proposal] = result.proposals;
    expect(proposal).toMatchObject({ rule: 'co-use-success-v1', fromKind: 'procedure', toKind: 'fact', support: 3, runs: 3, premiseRuns: 3, tasks: 9, reliance: 1, failedCoUse: 1 });
    expect(proposal.lift).toBeCloseTo(3, 6);
    expect(proposal.confidence).toBeGreaterThan(0.3);
    expect(proposal.taskIds).toEqual(['task-7', 'task-8', 'task-9']);
    expect(proposal.traceIds).toHaveLength(3);
    expect(proposal.ledgerIds.length).toBeGreaterThan(0);
    expect(proposal.digest).toBe(proposalDigest(proposal));
    expect(result.evidence.tasks).toMatchObject({ successful: 9, failed: 2, traced: 11, unjudged: 0, conflicting: 0 });
    expect(result.evidence.pairs.rejected.support).toBe(1);
    expect(result.evidence.scanned.truncated).toBe(false);
    // Read-only: nothing was written by inference.
    expect(w.db.ledger({ events: ['dependency'] }).entries).toEqual([]);
    expect(w.db.get(deploy.id)!.dependencies).toEqual([]);
    expect(inferDependencies(w.db)).toEqual(result);
  });

  it('never proposes a declared dependency, an untrusted premise, or a hub used everywhere', () => {
    const w = world();
    const declared = w.fact('Backups are encrypted with the team key.');
    const restore = w.procedure('Restore a backup with the team key.', [declared.id]);
    const rumor = w.db.store({ text: 'Somebody said restores need two people.', kind: 'fact', trust: 'untrusted', source: { uri: 'test:rumor' } });
    const hub = w.fact('All work happens in the shared project workspace.');
    const others = [w.procedure('Write a weekly status report.'), w.procedure('Triage new support tickets.'), w.procedure('Review open pull requests.')];
    for (let index = 0; index < 3; index++) w.task([restore, declared, hub], [restore, declared, hub], true);
    for (const other of others) for (let index = 0; index < 2; index++) w.task([other, hub], [other, hub], true);
    w.task([restore, rumor], [restore], true);
    const result = inferDependencies(w.db);
    expect(result.proposals).toEqual([]);
    expect(result.evidence.pairs.rejected.declared).toBe(1);
    expect(result.evidence.pairs.rejected.lift).toBeGreaterThanOrEqual(1);
    // The hub is used in every run: lift exactly 1, so it is not a dependency signal.
    expect(inferDependencies(w.db, { minLift: 1 }).proposals.map(proposal => proposal.to)).toContain(hub.id);
  });

  it('validates options and keeps the two-task support floor', () => {
    const w = world();
    expect(() => inferDependencies(w.db, { minSupport: 1 })).toThrow('minSupport');
    expect(() => inferDependencies(w.db, { bogus: 1 } as never)).toThrow('Unknown');
    expect(() => inferDependencies(w.db, { dependentKinds: ['fact'], premiseKinds: ['fact'] })).toThrow('disjoint');
    expect(() => inferDependencies(w.db, { maxLedgerPages: 0 })).toThrow('maxLedgerPages');
  });

  it('reports a truncated pass when a scan budget is exhausted', () => {
    const w = world();
    const deploy = w.procedure('Deploy the web service with the blue green script.');
    const region = w.fact('Production runs in the eu-west-1 region.');
    for (let index = 0; index < 3; index++) w.task([deploy, region], [deploy, region], true, 'verifier');
    expect(inferDependencies(w.db, { maxLedgerPages: 1 }).evidence.scanned).toMatchObject({ ledgerPages: 1, truncated: false });
    const truncated = inferDependencies(w.db, { maxRecords: 2 });
    expect(truncated.evidence.scanned).toMatchObject({ records: 2, truncated: true });
    expect(truncated.proposals).toEqual([]);
  });
});

describe('reviewDependency', () => {
  function proposed() {
    const w = world();
    const deploy = w.procedure('Deploy the web service with the blue green script.');
    const region = w.fact('Production runs in the eu-west-1 region.');
    const consumer = w.db.store({ text: 'Deploy notes for the on-call engineer.', kind: 'observation', trust: 'observed', source: { uri: 'test:notes' }, dependencies: [deploy.id] });
    background(w);
    for (let index = 0; index < 3; index++) w.task([deploy, region], [deploy, region], true);
    const [proposal] = inferDependencies(w.db).proposals;
    return { ...w, deploy, region, consumer, proposal };
  }

  it('accepts through one ledgered correct() so correcting the premise invalidates the dependent', () => {
    const w = proposed();
    const review = reviewDependency(w.db, w.proposal, 'accept', 'reviewer-1', { now: w.now, note: 'Deploy script hard-codes the region.' });
    expect(review).toMatchObject({ decision: 'accept', digest: w.proposal.digest, supersededId: w.deploy.id });
    const successor = w.db.get(review.dependentId)!;
    expect(successor).toMatchObject({ text: w.deploy.text, status: 'active', supersedes: w.deploy.id, dependencies: [w.region.id], trust: 'observed' });
    expect(w.db.get(w.deploy.id)!.status).toBe('superseded');
    // Accepting re-versions the dependent, so records that declared the old version are invalidated with it.
    expect(w.db.get(w.consumer.id)!.status).toBe('invalidated');
    const [receipt] = w.db.ledger({ events: ['dependency'] }).entries;
    expect(receipt).toMatchObject({ id: review.receiptId, memoryId: w.deploy.id, dependency: { decision: 'accept', reviewer: 'reviewer-1', digest: w.proposal.digest, from: w.deploy.id, to: w.region.id, note: 'Deploy script hard-codes the region.' } });
    const [correction] = w.db.ledger({ events: ['correction'] }).entries;
    expect(correction.memoryId).toBe(successor.id);
    expect(inferDependencies(w.db).proposals).toEqual([]);
    expect(inferDependencies(w.db).evidence.pairs.rejected.reviewed).toBe(1);

    w.db.correct(w.region.id, { text: 'Production runs in the us-east-1 region.', source: { uri: 'test:region-v2' }, reason: 'Region moved.' });
    expect(w.db.get(successor.id)!.status).toBe('invalidated');
    expect(w.db.isEligible(successor.id)).toBe(false);
    expect(w.db.compile({ query: 'deploy web service blue green', maxTokens: 2000 }).items.map(item => item.id)).not.toContain(successor.id);
  });

  it('rejects by receipt only, and suppresses the pair afterwards', () => {
    const w = proposed();
    const review = reviewDependency(w.db, w.proposal, 'reject', 'reviewer-1', { now: w.now });
    expect(review).toEqual({ receiptId: review.receiptId, decision: 'reject', digest: w.proposal.digest, dependentId: w.deploy.id });
    expect(w.db.get(w.deploy.id)).toMatchObject({ status: 'active', dependencies: [] });
    expect(w.db.ledger({ events: ['dependency'] }).entries[0].dependency).toMatchObject({ decision: 'reject', to: w.region.id });
    expect(inferDependencies(w.db).proposals).toEqual([]);
  });

  it('refuses a tampered, stale or repeated proposal and records nothing', () => {
    const w = proposed();
    expect(() => reviewDependency(w.db, { ...w.proposal, support: 99 }, 'accept', 'r')).toThrow('digest');
    expect(() => reviewDependency(w.db, { ...w.proposal, extra: 1 } as unknown as InferredDependency, 'accept', 'r')).toThrow('Unknown');
    expect(() => reviewDependency(w.db, w.proposal, 'maybe' as never, 'r')).toThrow();
    expect(() => reviewDependency(w.db, w.proposal, 'accept', '')).toThrow();
    expect(() => reviewDependency(w.db, w.proposal, 'accept', 'r', { bogus: true } as never)).toThrow('Unknown');
    const stale = proposed();
    stale.db.correct(stale.region.id, { text: 'Production runs in the us-east-1 region.', source: { uri: 'test:region-v2' }, reason: 'Region moved.' });
    expect(() => reviewDependency(stale.db, stale.proposal, 'accept', 'r')).toThrow('Premise changed');
    expect(stale.db.ledger({ events: ['dependency'] }).entries).toEqual([]);
    reviewDependency(w.db, w.proposal, 'accept', 'r', { now: w.now });
    expect(() => reviewDependency(w.db, w.proposal, 'accept', 'r', { now: w.now })).toThrow('already declared');
    expect(w.db.ledger({ events: ['dependency'] }).entries).toHaveLength(1);
  });

  it('follows a re-versioned dependent and needs the ledger', () => {
    const w = proposed();
    const moved = w.db.correct(w.deploy.id, { text: w.deploy.text, source: w.deploy.source, reason: 'Re-verified.' });
    const review = reviewDependency(w.db, w.proposal, 'accept', 'r', { now: w.now });
    expect(review.supersededId).toBe(moved.id);
    expect(w.db.get(review.dependentId)!.dependencies).toEqual([w.region.id]);

    const off = createLocalMemory({ path: ':memory:', agentId: 'alice', workspaceId: 'project', ledger: false }); opened.push(off);
    const a = off.store({ text: 'Procedure A.', kind: 'procedure', trust: 'observed', source: { uri: 'test:a' } });
    const b = off.store({ text: 'Fact B.', kind: 'fact', trust: 'observed', source: { uri: 'test:b' } });
    const body = { ...w.proposal, from: a.id, to: b.id };
    expect(() => reviewDependency(off, { ...body, digest: proposalDigest(body) }, 'accept', 'r')).toThrow('requires the ledger');
    expect(off.get(a.id)!.dependencies).toEqual([]);
  });
});

describe('skill dependents and the premise guard', () => {
  const passed: SkillValidation = { passed: true, evidence: 'Synthetic trial passed.', verifier: 'harness', taskId: 'trial-1', prerequisitesSatisfied: true };

  it('accepts a skill premise through linkPremise; correcting it retires the skill', async () => {
    const w = world();
    const evidence = w.fact('The release checklist has five steps.');
    const premise = w.fact('Release tags are signed with the project key.');
    const created = w.runtime.createSkill({ name: 'Release', prerequisites: [], steps: ['Run the checklist', 'Sign the tag'], parameters: {}, evidenceIds: [evidence.id] });
    const active = await w.runtime.trialSkill({ id: created.id, validation: passed });
    const record = w.db.get(active.recordId)!;
    background(w);
    for (let index = 0; index < 3; index++) w.task([record, premise, evidence], [record, premise, evidence], true);
    const proposals = inferDependencies(w.db).proposals;
    expect(proposals.map(proposal => [proposal.skillId, proposal.to])).toEqual([[created.id, premise.id]]);
    const review = reviewDependency(w.db, proposals[0], 'accept', 'reviewer', { runtime: w.runtime, now: w.now });
    expect(review).toMatchObject({ skillId: created.id, supersededId: active.recordId });
    expect(w.runtime.getSkill(created.id)).toMatchObject({ state: 'active', recordId: review.dependentId, premises: [{ memoryId: premise.id, receiptId: review.receiptId }] });
    expect(inferDependencies(w.db).proposals).toEqual([]);
    w.db.correct(premise.id, { text: 'Release tags are unsigned.', source: { uri: 'test:tags-v2' }, reason: 'Policy changed.' });
    expect(w.runtime.getSkill(created.id)).toMatchObject({ state: 'retired', reason: 'Linked premise was corrected or is no longer eligible.' });
  });

  it('holds a dependent whose co-used premise changed before inference had enough support, and never writes', () => {
    const w = world();
    const deploy = w.procedure('Deploy the web service with the blue green script.');
    const region = w.fact('Production runs in the eu-west-1 region.');
    const unrelated = w.procedure('Archive old log files weekly.');
    background(w);
    w.task([deploy, region], [deploy, region], true);
    w.task([unrelated], [unrelated], true);
    expect(inferDependencies(w.db).proposals).toEqual([]);
    const guard = createPremiseGuard(w.db);
    expect(guard.allows(deploy.id)).toBe(true);
    w.db.correct(region.id, { text: 'Production runs in the us-east-1 region.', source: { uri: 'test:region-v2' }, reason: 'Region moved.' });
    expect(w.db.isEligible(deploy.id)).toBe(true);
    const recalled = w.db.recall({ query: 'deploy web service blue green archive log', limit: 10 });
    const compiled = w.db.compile({ query: 'deploy web service blue green', maxTokens: 2000 }).items;
    expect(recalled.map(item => item.memory.id)).toContain(deploy.id);
    const before = w.db.ledger({ limit: 1000 }).entries.length;
    expect(guard.holds(deploy.id)).toEqual([{ premiseId: region.id, reason: 'premise-changed', support: 1, runs: 1, reliance: 1 }]);
    expect(guard.allows(deploy.id)).toBe(false);
    expect(guard.allows(unrelated.id)).toBe(true);
    expect(guard.filter(recalled).map(item => item.memory.id)).not.toContain(deploy.id);
    expect(guard.filter(compiled).map(item => item.id)).not.toContain(deploy.id);
    expect(w.db.ledger({ limit: 1000 }).entries.length).toBe(before);
    expect(w.db.get(deploy.id)).toMatchObject({ status: 'active', dependencies: [] });
    // Revising the dependent after the change is the reviewer's release.
    const revised = w.db.correct(deploy.id, { text: 'Deploy the web service to us-east-1 with the blue green script.', source: { uri: 'test:deploy-v2' }, reason: 'Region moved.' });
    expect(guard.allows(revised.id)).toBe(true);
  });

  it('does not hold a dependent that ran successfully without the premise', () => {
    const w = world();
    const deploy = w.procedure('Deploy the web service with the blue green script.');
    const tip = w.fact('The deploy dashboard has a dark mode.');
    background(w);
    w.task([deploy, tip], [deploy, tip], true);
    for (let index = 0; index < 3; index++) w.task([deploy, tip], [deploy], true);
    const guard = createPremiseGuard(w.db);
    w.db.correct(tip.id, { text: 'The deploy dashboard has no dark mode.', source: { uri: 'test:tip-v2' }, reason: 'Changed.' });
    expect(guard.allows(deploy.id)).toBe(true);
    expect(() => createPremiseGuard(w.db, { holdReliance: 2 })).toThrow('holdReliance');
  });
});
