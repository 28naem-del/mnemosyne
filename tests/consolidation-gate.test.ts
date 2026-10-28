import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { replayState } from '../src/local/replay.js';
import type { MemoryRecord } from '../src/local/types.js';
import {
  buildReplaySet, consolidate, consolidationReceipts, createConsolidationSigner, deterministicProposer, diffDigest, gateConsolidation,
  passRecords, proposeConsolidation, rollbackConsolidation, splitHoldout, verifyConsolidationChain,
  type ConsolidationProposal,
} from '../src/consolidation/index.js';
import { runConsolidationDemo } from '../src/consolidation/demo.js';

/**
 * The consolidation gate keeps a pass only when replaying the agent's own
 * recorded outcomes under S+D does not regress against S, every invariant
 * holds, and there is evidence; a kept pass rolls back to the identical
 * stateSha256. All fixtures are synthetic.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach((db) => db.close()); });
const signer = createConsolidationSigner({ seed: new Uint8Array(32).fill(3) });

function store(options: { ledger?: boolean } = {}): LocalMemory {
  let tick = Date.UTC(2026, 0, 1);
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'agent', retrieval: 'lexical', ledger: options.ledger === false ? false : { queries: 'text' }, now: () => new Date(tick += 1000) });
  opened.push(db);
  return db;
}

function task(db: LocalMemory, taskId: string, query: string, options: { limit?: number; scoring?: 'overlap' | 'bm25'; used?: string[] } = {}): void {
  db.recall({ query, limit: options.limit ?? 1, ...(options.scoring ? { lexicalScoring: options.scoring } : {}) });
  db.recordRetrievalOutcome({ taskId, success: true, verifier: 'test-ci (synthetic)', evidence: taskId });
  for (const id of options.used ?? []) db.recordOutcome({ memoryId: id, taskId, success: true, verifier: 'test-ci (synthetic)', evidence: `${taskId}:${id}` });
}

const put = (db: LocalMemory, text: string, extra: Partial<Parameters<LocalMemory['store']>[0]> = {}): MemoryRecord =>
  db.store({ text, kind: 'procedure', trust: 'observed', source: { uri: `note://${text.length}` }, ...extra });

const only = (proposals: ConsolidationProposal[]) => () => proposals;
const stateAt = (db: LocalMemory, knownAt: string) => replayState(db, { knownAt }, { records: true });
const nowCut = (db: LocalMemory) => db.export().exportedAt;

/** Two near-duplicate deploy procedures whose merge fits both into k=1. */
function deployFixture() {
  const db = store();
  const a = put(db, 'Deploys run from the release branch after the smoke suite passes.');
  const b = put(db, 'Deploys run from the release branch once the smoke suite passes.');
  put(db, 'Grafana dashboards are kept under the ops folder.', { kind: 'fact' });
  task(db, 'deploy-1', 'deploys after once smoke suite', { used: [a.id, b.id] });
  task(db, 'deploy-2', 'release branch after once passes', { used: [a.id, b.id] });
  return { db, a, b };
}

/** A merge of two short records that outranks the long record the task actually used. */
function regressionFixture(regressingTaskId = 'rollback-task') {
  const db = store();
  const shipA = put(db, 'Ship the deploy with the release checklist.', { kind: 'fact' });
  const shipB = put(db, 'Ship the deploy with the rollback checklist.', { kind: 'fact' });
  const runbook = put(db, 'To rollback a broken deploy, redeploy the previous release tag from the pipeline page and confirm that the health checks pass.');
  const dash = put(db, 'Grafana dashboards are kept under the ops folder.', { kind: 'fact' });
  task(db, regressingTaskId, 'rollback deploy release', { scoring: 'overlap' });
  task(db, 'dash-task', 'grafana dashboards folder');
  return { db, shipA, shipB, runbook, dash };
}

describe('consolidation gate', () => {
  it('keeps an improving merge, applies it as a dependent private record, and rolls back to the identical stateSha256', () => {
    const { db, a, b } = deployFixture();
    const before = stateAt(db, nowCut(db));
    const result = consolidate(db, { signer })!;
    expect(result.verdict).toBe('kept');
    expect(result.receipt.scores).toMatchObject({ tasks: 2, before: 2, after: 4, delta: 2, holdout: null, noMemory: 0, unreplayable: 0, perProposal: [2] });
    expect(result.receipt.invariants.every((invariant) => invariant.ok)).toBe(true);
    expect(result.receipt.stateBefore).toBe(before.stateSha256);
    expect(result.created).toHaveLength(1);
    const merged = db.get(result.created[0].id)!;
    expect(merged).toMatchObject({ visibility: 'private', trust: 'observed', kind: 'procedure', source: { uri: `consolidation:${result.receipt.passId}`, revision: result.diff.digest } });
    expect([...merged.dependencies].sort()).toEqual([a.id, b.id].sort());
    expect(db.getRecordFingerprint(merged.id)).toBe(result.created[0].fingerprint);
    expect(passRecords(db, result.receipt.passId).map((record) => record.id)).toEqual([merged.id]);
    expect(stateAt(db, nowCut(db)).stateSha256).toBe(result.receipt.stateAfter);
    expect(result.receipt.stateAfter).not.toBe(before.stateSha256);

    const undone = rollbackConsolidation(db, result.receipt.passId, { signer });
    const after = stateAt(db, nowCut(db));
    expect(undone).toMatchObject({ verdict: 'rolled_back', restored: true, deletedIds: [merged.id] });
    expect(after.stateSha256).toBe(before.stateSha256);
    expect(after.items).toEqual(before.items);
    expect(db.get(merged.id)).toBeNull();
    expect(() => rollbackConsolidation(db, result.receipt.passId, { signer })).toThrow(/already rolled back/);
    expect(verifyConsolidationChain(db)).toMatchObject({ ok: true, receipts: 2, errors: [] });
  });

  it('demo: a kept pass rolls back to the identical stateSha256, and every verdict is on one verified chain', () => {
    const lines: string[] = [];
    const demo = runConsolidationDemo({ log: (line) => lines.push(line) });
    expect(demo.passes.map((pass) => pass.verdict)).toEqual(['rolled_back', 'kept', 'rolled_back', 'no_evidence']);
    expect(demo.passes[0].reason).toMatch(/^regression: proposal 1 alone delta -1/);
    expect(demo.passes[2].reason).toMatch(/no-untrusted-to-policy/);
    expect(demo.rollback.restored).toBe(true);
    expect(demo.rollback.stateAfterRollback).toBe(demo.rollback.stateBefore);
    expect(demo.rollback.stateAfterApply).not.toBe(demo.rollback.stateBefore);
    expect(demo.chain).toMatchObject({ ok: true, receipts: 4 });
    expect(lines.join('\n')).toContain('identical: true');
    // Same synthetic history, same verdicts and numbers; record ids (and so state hashes) are random per run.
    const again = runConsolidationDemo({ log: () => {} });
    expect(again.passes.map(({ verdict, reason, delta, holdoutDelta, perProposal }) => ({ verdict, reason, delta, holdoutDelta, perProposal })))
      .toEqual(demo.passes.map(({ verdict, reason, delta, holdoutDelta, perProposal }) => ({ verdict, reason, delta, holdoutDelta, perProposal })));
  });

  it('rolls back a merge that pushes the evidence a task used out of the top-k', () => {
    const { db, shipA, shipB } = regressionFixture();
    const before = stateAt(db, nowCut(db)).stateSha256;
    const proposer = only([{ kind: 'merge', sources: [shipA.id, shipB.id], outputs: [{ text: `${shipA.text} ${shipB.text}`, kind: 'fact', trust: 'observed' }], rationale: 'near-duplicate facts' }]);
    const result = consolidate(db, { signer, proposer })!;
    expect(result.verdict).toBe('rolled_back');
    expect(result.receipt.reason).toBe('regression: outcome delta -1 over 2 replayed task(s)');
    expect(result.receipt.scores).toMatchObject({ before: 2, after: 1, delta: -1 });
    expect(result.receipt.proposals[0].fault).toBe(true);
    expect(result.created).toEqual([]);
    expect(stateAt(db, nowCut(db)).stateSha256).toBe(before);
    // Backoff: the faulted proposal is not proposed again until the replay set doubles.
    expect(proposeConsolidation(db, { signer, proposer })).toBeNull();
    expect(proposeConsolidation(db, { signer, proposer, backoff: false })).not.toBeNull();
    task(db, 'more-1', 'grafana ops'); task(db, 'more-2', 'dashboards kept');
    expect(proposeConsolidation(db, { signer, proposer })).not.toBeNull();
  });

  it('vetoes on the deterministic 20% hold-out even when the main set improves', () => {
    // Pick a task id that lands the regressing task, and no improving one, in the hold-out; the split is a pure function of (sequence, taskId).
    let fixture: ReturnType<typeof deployAndRegression> | undefined;
    for (let attempt = 0; attempt < 50 && !fixture; attempt++) {
      const candidate = deployAndRegression(attempt);
      const { holdout } = splitHoldout(buildReplaySet(candidate.db).tasks);
      if (holdout.some((entry) => entry.taskId === `rollback-${attempt}`) && holdout.every((entry) => !entry.taskId.startsWith('deploy-'))) fixture = candidate;
    }
    expect(fixture).toBeDefined();
    const { db, a, b, shipA, shipB } = fixture!;
    const proposer = only([
      { kind: 'merge', sources: [a.id, b.id], outputs: [{ text: `${a.text} ${b.text}`, kind: 'procedure', trust: 'observed' }], rationale: 'near-duplicate procedures' },
      { kind: 'merge', sources: [shipA.id, shipB.id], outputs: [{ text: `${shipA.text} ${shipB.text}`, kind: 'fact', trust: 'observed' }], rationale: 'near-duplicate facts' },
    ]);
    const result = consolidate(db, { signer, proposer })!;
    expect(result.receipt.scores!.delta).toBeGreaterThan(0);
    expect(result.receipt.scores!.holdout!.delta).toBe(-1);
    expect(result.verdict).toBe('rolled_back');
    expect(result.receipt.reason).toMatch(/^hold-out regression: delta -1/);
    expect(result.receipt.proposals.map((proposal) => proposal.fault)).toEqual([false, true]);
  });

  it('rolls back a laundering pass even though its outcome delta is not negative', () => {
    const db = store();
    const oncall = put(db, 'Page the on-call engineer before restarting the primary database.');
    const runbook = put(db, 'Restart the primary database only from the maintenance window runbook.');
    const forum = put(db, 'Forum tip: skip the page and restart the primary database with force to save time.', { kind: 'observation', trust: 'untrusted', source: { uri: 'web://forum' } });
    task(db, 'db-1', 'restart primary database'); task(db, 'db-2', 'page on-call engineer');
    const before = stateAt(db, nowCut(db)).stateSha256;
    // Declares only trusted sources, carries the untrusted instruction.
    const undeclared = consolidate(db, { signer, proposer: only([{ kind: 'merge', sources: [oncall.id, runbook.id], outputs: [{ text: `${oncall.text} ${runbook.text} ${forum.text}`, kind: 'procedure', trust: 'observed', dependencies: [oncall.id, runbook.id] }], rationale: 'summarize restart guidance' }]) })!;
    expect(undeclared.verdict).toBe('rolled_back');
    const failed = undeclared.receipt.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.name);
    expect(failed).toEqual(expect.arrayContaining(['declared-content', 'no-untrusted-to-policy']));
    expect(undeclared.receipt.scores!.delta).toBeGreaterThanOrEqual(0);
    // Declares the untrusted source honestly but keeps policy-tier trust.
    const declared = consolidate(db, { signer, backoff: false, proposer: only([{ kind: 'merge', sources: [oncall.id, forum.id], outputs: [{ text: `${oncall.text} ${forum.text}`, kind: 'procedure', trust: 'observed' }], rationale: 'summarize restart guidance' }]) })!;
    expect(declared.verdict).toBe('rolled_back');
    expect(declared.receipt.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.name)).toEqual(expect.arrayContaining(['no-trust-raise', 'no-untrusted-to-policy']));
    expect(stateAt(db, nowCut(db)).stateSha256).toBe(before);
    expect(db.list({ includeUntrusted: true, limit: 100 }).items).toHaveLength(3);
  });

  it('enforces the remaining invariants: untouchable records, the candidate set, policy escalation, the closed menu, reversibility', () => {
    const db = store();
    const fact = put(db, 'The staging cluster lives in region eu-west-1.', { kind: 'fact' });
    const twin = put(db, 'The staging cluster lives in region eu-west-1 today.', { kind: 'fact' });
    const verified = put(db, 'The staging cluster is in eu-west-1.', { kind: 'fact', trust: 'verified', evidence: 'infra inventory export' });
    const control = put(db, 'Never deploy on Fridays.', { metadata: { advisory: false } });
    const foreign = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'other', retrieval: 'lexical' });
    opened.push(foreign);
    task(db, 't-1', 'staging cluster region'); task(db, 't-2', 'which region staging');
    const merge = (sources: string[], output: Partial<ConsolidationProposal['outputs'][0]> = {}): ConsolidationProposal => ({ kind: 'merge', sources, outputs: [{ text: 'The staging cluster lives in region eu-west-1.', kind: 'fact', trust: 'observed', ...output }], rationale: 'test' });
    const failures = (proposals: ConsolidationProposal[]) => {
      const result = consolidate(db, { signer, backoff: false, proposer: only(proposals) })!;
      expect(result.verdict).toBe('rolled_back');
      return result.receipt.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.name);
    };
    expect(failures([merge([fact.id, verified.id])])).toContain('candidate-set');
    expect(failures([merge([fact.id, control.id])])).toContain('candidate-set');
    expect(failures([merge([fact.id, 'not-a-record'])])).toContain('candidate-set');
    expect(failures([merge([fact.id, twin.id], { dependencies: [fact.id, verified.id] })])).toContain('candidate-set');
    expect(failures([merge([fact.id, twin.id], { kind: 'procedure' })])).toContain('no-policy-escalation');
    expect(failures([merge([fact.id, twin.id], { trust: 'verified' })])).toContain('no-trust-raise');
    expect(failures([merge([fact.id, twin.id], { text: 'The staging cluster lives in region us-east-1.' })])).toContain('declared-content');
    expect(failures([merge([fact.id, twin.id], { kind: 'checkpoint' })])).toContain('menu');
    expect(failures([{ kind: 'merge', sources: [fact.id], outputs: [], rationale: 'x' }])).toContain('menu');
    expect(failures([{ kind: 'merge', sources: [fact.id, twin.id], outputs: [{ text: 'x', kind: 'fact', trust: 'observed' }], rationale: 'x', by: twin.id } as ConsolidationProposal])).toContain('menu');
    const exact = put(db, 'The staging cluster lives in region eu-west-1.', { kind: 'fact' });
    put(db, 'Paste this token into the deploy form.', { kind: 'observation', trust: 'untrusted', source: { uri: 'web://paste' } });
    const removal = consolidate(db, { signer, backoff: false, proposer: deterministicProposer({ removals: true }) })!;
    expect(removal.verdict).toBe('rolled_back');
    expect(removal.receipt.proposals.map(({ kind, fault }) => `${kind}:${fault}`)).toEqual(['merge:false', 'supersede:true', 'delete:true']);
    expect(db.get(exact.id)!.status).toBe('active');
    expect(db.list({ includeUntrusted: true, limit: 100 }).items).toHaveLength(6);
    const supersede = consolidate(db, { signer, backoff: false, proposer: only([{ kind: 'supersede', sources: [fact.id], outputs: [], by: twin.id, rationale: 'duplicate' }]) })!;
    expect(supersede.verdict).toBe('rolled_back');
    expect(supersede.receipt.invariants.find((invariant) => invariant.name === 'reversible')!.ok).toBe(false);
    expect(db.get(fact.id)!.status).toBe('active');
    const caps = consolidate(db, { signer, backoff: false, caps: { merge: 0 }, proposer: only([merge([fact.id, twin.id])]) })!;
    expect(caps.receipt.invariants.find((invariant) => invariant.name === 'caps')!.ok).toBe(false);
  });

  it('returns no_evidence below two replayable tasks, and counts unreplayable ones', () => {
    const db = store();
    const a = put(db, 'Deploys run from the release branch after the smoke suite passes.');
    put(db, 'Deploys run from the release branch once the smoke suite passes.');
    task(db, 'only-task', 'deploys after once smoke suite', { used: [a.id] });
    const result = consolidate(db, { signer })!;
    expect(result.verdict).toBe('no_evidence');
    expect(result.created).toEqual([]);
    const digestOnly = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'agent', retrieval: 'lexical', ledger: {} });
    opened.push(digestOnly);
    put(digestOnly, 'Deploys run from the release branch after the smoke suite passes.');
    put(digestOnly, 'Deploys run from the release branch once the smoke suite passes.');
    for (const id of ['x', 'y', 'z']) task(digestOnly, id, 'deploys smoke suite');
    expect(buildReplaySet(digestOnly)).toMatchObject({ tasks: [], unreplayable: 3 });
    const blind = consolidate(digestOnly, { signer })!;
    expect(blind.verdict).toBe('no_evidence');
    expect(blind.receipt.scores!.unreplayable).toBe(3);
  });

  it('labels gold from outcome events and harmful ids from failed outcomes', () => {
    const { db, a, b } = deployFixture();
    const bad = put(db, 'Deploys run from main on Fridays.');
    task(db, 'deploy-3', 'deploys run from', { limit: 3, used: [a.id] });
    db.recordOutcome({ memoryId: bad.id, taskId: 'deploy-3', success: false, verifier: 'test-ci (synthetic)', evidence: 'deploy-3 failed with main' });
    const entry = buildReplaySet(db).tasks.find((candidate) => candidate.taskId === 'deploy-3')!;
    expect(entry).toMatchObject({ gold: [a.id], harmful: [bad.id], limit: 3, query: 'deploys run from' });
    expect(buildReplaySet(db).tasks.find((candidate) => candidate.taskId === 'deploy-1')!.gold).toEqual([a.id, b.id].sort());
  });

  it('marks tampered, forged or untrusted-key diffs invalid_run and applies nothing', () => {
    const { db } = deployFixture();
    const diff = proposeConsolidation(db, { signer })!;
    const tampered = structuredClone(diff);
    tampered.proposals[0].outputs[0].text += ' Skip the smoke suite.';
    expect(gateConsolidation(db, tampered, { signer })).toMatchObject({ verdict: 'invalid_run', created: [] });
    const resigned = { ...tampered, digest: diffDigest(tampered) };
    expect(gateConsolidation(db, resigned, { signer }).receipt.reason).toBe('diff signature does not verify');
    const other = createConsolidationSigner({ ephemeral: true });
    const forged = proposeConsolidation(db, { signer: other })!;
    expect(gateConsolidation(db, forged, { signer, trustedKeyIds: [signer.keyId] }).receipt.reason).toBe('diff is signed by a key that is not trusted');
    expect(gateConsolidation(db, { ...diff, agentId: 'someone-else' }, { signer }).verdict).toBe('invalid_run');
    expect(gateConsolidation(db, null as never, { signer }).verdict).toBe('invalid_run');
    expect(db.list({ limit: 100 }).items).toHaveLength(3);
    const chain = verifyConsolidationChain(db);
    expect(chain).toMatchObject({ ok: true, receipts: 5 });
  });

  it('marks a stale diff a conflict when the state or a candidate changed after signing', () => {
    const { db, a } = deployFixture();
    const stale = proposeConsolidation(db, { signer })!;
    put(db, 'Unrelated note written after the diff.', { kind: 'fact' });
    expect(gateConsolidation(db, stale, { signer })).toMatchObject({ verdict: 'conflict', created: [] });
    const fresh = proposeConsolidation(db, { signer })!;
    db.correct(a.id, { text: 'Deploys run from the release branch after the full suite passes.', source: a.source, reason: 'suite renamed' });
    const result = gateConsolidation(db, fresh, { signer });
    expect(result.verdict).toBe('conflict');
    expect(verifyConsolidationChain(db).ok).toBe(true);
  });

  it('refuses a rollback whose created records gained later dependent work, and records the conflict', () => {
    const { db } = deployFixture();
    const kept = consolidate(db, { signer })!;
    expect(kept.verdict).toBe('kept');
    put(db, 'Release notes cite the merged deploy procedure.', { kind: 'fact', dependencies: [kept.created[0].id] });
    const before = stateAt(db, nowCut(db)).stateSha256;
    const refused = rollbackConsolidation(db, kept.receipt.passId, { signer });
    expect(refused).toMatchObject({ verdict: 'conflict', restored: false, deletedIds: [] });
    expect(stateAt(db, nowCut(db)).stateSha256).toBe(before);
    expect(consolidationReceipts(db).map(({ receipt }) => `${receipt.action}:${receipt.verdict}`)).toEqual(['gate:kept', 'rollback:conflict']);
    expect(verifyConsolidationChain(db).ok).toBe(true);
  });

  it('lets forget() of a source reach the consolidated record through its declared dependency', () => {
    const { db, a } = deployFixture();
    const kept = consolidate(db, { signer })!;
    db.forget(a.id);
    expect(db.get(kept.created[0].id)).toBeNull();
  });

  it('bounds a consolidated record by its sources\' validUntil', () => {
    const db = store();
    const a = put(db, 'Deploys run from the release branch after the smoke suite passes.', { validUntil: '2027-01-01T00:00:00.000Z' });
    const b = put(db, 'Deploys run from the release branch once the smoke suite passes.');
    task(db, 'deploy-1', 'deploys after once smoke suite', { used: [a.id, b.id] });
    task(db, 'deploy-2', 'release branch after once passes', { used: [a.id, b.id] });
    const kept = consolidate(db, { signer })!;
    expect(kept.verdict).toBe('kept');
    expect(db.get(kept.created[0].id)!.validUntil).toBe('2027-01-01T00:00:00.000Z');
  });

  it('writes nothing when the ledger is disabled: no receipt, no apply', () => {
    const db = store({ ledger: false });
    put(db, 'Deploys run from the release branch after the smoke suite passes.');
    put(db, 'Deploys run from the release branch once the smoke suite passes.');
    const diff = proposeConsolidation(db, { signer })!;
    expect(() => gateConsolidation(db, diff, { signer })).toThrow(/enabled ledger/);
    expect(db.list({ limit: 100 }).items).toHaveLength(2);
  });

  it('validates options with closed key sets', () => {
    const { db } = deployFixture();
    expect(() => proposeConsolidation(db, { signer, extra: true } as never)).toThrow(/Unknown|unknown|not allowed/);
    expect(() => proposeConsolidation(db, { signer, caps: { merge: 99 } })).toThrow(/caps.merge/);
    expect(() => proposeConsolidation(db, { signer, caps: { fuse: 1 } as never })).toThrow();
    expect(() => proposeConsolidation(db, {} as never)).toThrow(/signer/);
    expect(() => verifyConsolidationChain(db, { pinned: [] } as never)).toThrow();
  });
});

function deployAndRegression(salt: number) {
  const fixture = regressionFixture(`rollback-${salt}`);
  const { db } = fixture;
  const a = put(db, 'Deploys run from the release branch after the smoke suite passes.');
  const b = put(db, 'Deploys run from the release branch once the smoke suite passes.');
  for (let index = 0; index < 4; index++) task(db, `deploy-${index}-${salt}`, index % 2 ? 'release branch after once passes' : 'deploys after once smoke suite', { used: [a.id, b.id] });
  for (let index = 0; index < 4; index++) task(db, `dash-${index}-${salt}`, 'grafana dashboards folder');
  return { ...fixture, a, b };
}
