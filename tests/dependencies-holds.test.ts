import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalMemory, type LocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { createPremiseGuard, inferDependencies, listPremiseHolds, reviewDependency, type PremiseHoldList } from '../src/dependencies/index.js';

const directories: string[] = [];
const cli = resolve('dist/cli/index.js');
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-dependency-holds-')); directories.push(root);
  return { root, db: join(root, 'memory.sqlite') };
}
type Fixture = ReturnType<typeof fixture>;
const scope = (f: Fixture) => ['--db', f.db, '--workspace', 'dependencies-test', '--agent', 'controller'];
const open = (f: Fixture) => createLocalMemory({ path: f.db, workspaceId: 'dependencies-test', agentId: 'controller', retrieval: 'lexical' });
function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, MNEMOSYNE_TOKEN: '' } });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); return result;
}
function succeeds(args: string[]) {
  const result = invoke(args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}
function fails(args: string[], message: string) {
  const result = invoke(args);
  expect(result.status, result.stdout).toBe(1); expect(result.stderr).toContain(message); expect(result.stdout).toBe('');
  return result;
}

/** Synthetic: each procedure used once with its premise in a successful task, then
 * every premise corrected. One co-use is below inference's minimum of two. */
function seed(f: Fixture) {
  const memory = open(f), runtime = new MemoryRuntime(memory);
  const store = (text: string, kind: 'fact' | 'procedure') => memory.store({ text, kind, trust: 'observed', source: { uri: `test://holds/${kind}/${text.length}` } });
  try {
    const deploy = store('Deploy the web service with the blue green script.', 'procedure');
    const region = store('Production runs in the eu-west-1 region.', 'fact');
    const backup = store('Back up the ledger database to the archive bucket nightly.', 'procedure');
    const bucket = store('The archive bucket is named ledger-archive-7.', 'fact');
    const other = store('Rotate the service credentials with the vault tool.', 'procedure');
    const vault = store('The vault tool requires a hardware key.', 'fact');
    let serial = 0;
    const task = (records: MemoryRecord[], used: MemoryRecord[]) => runtime.recordTrace({ taskId: `task-${++serial}`, query: 'synthetic', retrievedIds: records.map(record => record.id), usedIds: used.map(record => record.id), outcome: { success: true, evidence: `Synthetic evidence ${serial}.`, verifier: 'harness' } });
    for (let index = 0; index < 4; index++) task([other, vault], [other]);
    task([deploy, region], [deploy, region]);
    task([backup, bucket], [backup, bucket]);
    const regionV2 = memory.correct(region.id, { text: 'Production runs in the us-east-1 region.', source: { uri: 'test://holds/region-v2' }, reason: 'Region moved.' });
    const bucketV2 = memory.correct(bucket.id, { text: 'The archive bucket is named ledger-archive-8.', source: { uri: 'test://holds/bucket-v2' }, reason: 'Bucket renamed.' });
    return { deploy: deploy.id, region: region.id, regionV2: regionV2.id, backup: backup.id, bucket: bucket.id, bucketV2: bucketV2.id };
  } finally { memory.close(); }
}
const holds = (f: Fixture, extra: string[] = []) => succeeds(['dependencies', ...scope(f), '--holds', ...extra]) as PremiseHoldList;

describe('mnemosy dependencies --holds', () => {
  it('lists, releases and accepts a single-co-use guard hold from the CLI', () => {
    const f = fixture(), ids = seed(f);
    // Inference cannot see one co-use; the guard holds both procedures.
    expect((succeeds(['dependencies', ...scope(f), '--infer']) as { proposals: unknown[] }).proposals).toEqual([]);
    const listed = holds(f, ['--read-only', '--no-capture']);
    expect(listed.holds.map(hold => [hold.from, hold.to]).sort()).toEqual([[ids.deploy, ids.region], [ids.backup, ids.bucket]].sort());
    const deploy = listed.holds.find(hold => hold.from === ids.deploy)!;
    const backup = listed.holds.find(hold => hold.from === ids.backup)!;
    expect(deploy).toMatchObject({ rule: 'co-use-success-v1', support: 1, runs: 1, taskIds: ['task-5'], hold: { reason: 'premise-changed', premiseStatus: 'superseded', correctionId: ids.regionV2, correctionReason: 'Region moved.', linkTo: ids.regionV2 } });
    expect(deploy.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(deploy.traceIds).toHaveLength(1);

    // Release (reject) needs a reason, then ledgers a receipt and the guard lets go.
    fails(['dependencies', ...scope(f), '--review', deploy.digest, '--reject', '--reviewer', 'ops-lead'], 'Releasing a guard hold requires --reason');
    const released = succeeds(['dependencies', ...scope(f), '--review', deploy.digest, '--reject', '--reviewer', 'ops-lead', '--reason', 'Deploy reads the region at run time.']);
    expect(released).toMatchObject({ decision: 'reject', digest: deploy.digest, dependentId: ids.deploy });

    // Accept links the dependent to the premise's current version through correct().
    const accepted = succeeds(['dependencies', ...scope(f), '--review', backup.digest, '--accept', '--reviewer', 'ops-lead']) as { dependentId: string; supersededId: string; receiptId: string };
    expect(accepted).toMatchObject({ decision: 'accept', supersededId: ids.backup });

    expect(holds(f).holds).toEqual([]);
    // Idempotence: a decided hold is gone, so its digest names nothing current.
    fails(['dependencies', ...scope(f), '--review', deploy.digest, '--reject', '--reviewer', 'ops-lead', '--reason', 'Again.'], 'No current proposal or hold has that digest');
    fails(['dependencies', ...scope(f), '--review', backup.digest, '--accept', '--reviewer', 'ops-lead'], 'No current proposal or hold has that digest');

    const memory = open(f);
    try {
      const guard = createPremiseGuard(memory);
      expect(guard.allows(ids.deploy)).toBe(true);
      expect(guard.allows(accepted.dependentId)).toBe(true);
      const receipts = memory.ledger({ events: ['dependency'] }).entries.map(entry => entry.dependency!);
      expect(receipts).toHaveLength(2);
      expect(receipts.find(receipt => receipt.decision === 'reject')).toMatchObject({ from: ids.deploy, to: ids.region, reviewer: 'ops-lead', note: 'Deploy reads the region at run time.', digest: deploy.digest, hold: { linkTo: ids.regionV2 } });
      expect(receipts.find(receipt => receipt.decision === 'accept')).toMatchObject({ from: ids.backup, to: ids.bucket, digest: backup.digest });
      expect(memory.get(accepted.dependentId)).toMatchObject({ status: 'active', supersedes: ids.backup, dependencies: [ids.bucketV2] });
      expect(memory.get(ids.deploy)).toMatchObject({ status: 'active', dependencies: [] });
      // The cascade now applies: the next correction of the bucket invalidates the procedure.
      memory.correct(ids.bucketV2, { text: 'The archive bucket is named ledger-archive-9.', source: { uri: 'test://holds/bucket-v3' }, reason: 'Renamed again.' });
      expect(memory.get(accepted.dependentId)?.status).toBe('invalidated');
    } finally { memory.close(); }
  });

  it('refuses a changed digest, and write modes under restrictive policies, before writing', () => {
    const f = fixture(), ids = seed(f);
    const [hold] = holds(f).holds.filter(item => item.from === ids.deploy);
    const memory = open(f);
    try { memory.correct(ids.regionV2, { text: 'Production runs in the ap-south-1 region.', source: { uri: 'test://holds/region-v3' }, reason: 'Moved again.' }); } finally { memory.close(); }
    // The premise's current version changed, so the hold the reviewer saw is stale.
    fails(['dependencies', ...scope(f), '--review', hold.digest, '--accept', '--reviewer', 'ops-lead'], 'No current proposal or hold has that digest');
    const fresh = holds(f).holds.find(item => item.from === ids.deploy)!;
    expect(fresh.digest).not.toBe(hold.digest);
    expect(fresh.hold?.linkTo).not.toBe(ids.regionV2);
    for (const flag of ['--read-only', '--no-capture']) {
      fails(['dependencies', ...scope(f), '--review', fresh.digest, '--accept', '--reviewer', 'ops-lead', flag], `disabled by ${flag}`);
      fails(['dependencies', ...scope(f), '--review', fresh.digest, '--reject', '--reviewer', 'ops-lead', '--reason', 'No.', flag], `disabled by ${flag}`);
    }
    fails(['dependencies', ...scope(f), '--holds', '--no-recall'], 'disabled by --no-recall');
    const check = open(f);
    try { expect(check.ledger({ events: ['dependency'] }).entries).toEqual([]); } finally { check.close(); }
  });

  it('rejects malformed hold invocations before SQLite is created', () => {
    const f = fixture();
    const cases: [string[], string][] = [
      [['--holds', '--infer'], 'exactly one of --infer, --holds or --review'],
      [['--holds', '--review', 'd'.repeat(64), '--accept', '--reviewer', 'ops-lead'], 'exactly one of --infer, --holds or --review'],
      [['--holds', '--min-support', '2'], 'Unsupported option'],
      [['--holds', '--reviewer', 'ops-lead'], 'Unsupported option'],
      [['--holds', '--json', '[]'], 'must contain an object'],
    ];
    for (const [args, message] of cases) fails(['dependencies', ...scope(f), ...args], message);
    expect(readdirSync(f.root)).toEqual([]);
  });

  it('documents --holds in --help', () => {
    const result = invoke(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('mnemosy dependencies [scope] --holds [--json JSON]');
  });
});

describe('listPremiseHolds', () => {
  const opened: LocalMemory[] = [];
  afterEach(() => { opened.splice(0).forEach(db => db.close()); });
  function world() {
    let tick = Date.parse('2026-10-29T00:00:00.000Z');
    const now = () => new Date(tick += 1000);
    const db = createLocalMemory({ path: ':memory:', agentId: 'alice', workspaceId: 'project', now, retrieval: 'lexical' }); opened.push(db);
    const runtime = new MemoryRuntime(db, { now });
    const store = (text: string, kind: 'fact' | 'procedure') => db.store({ text, kind, trust: 'observed', source: { uri: `test:${text.slice(0, 12)}` } });
    let serial = 0;
    const task = (used: MemoryRecord[], success = true) => runtime.recordTrace({ taskId: `task-${++serial}`, query: 'synthetic', retrievedIds: used.map(record => record.id), usedIds: used.map(record => record.id), outcome: { success, evidence: `Synthetic ${serial}.`, verifier: 'harness' } });
    return { db, runtime, now, store, task };
  }

  it('matches the guard, never writes, and keeps automatic inference at two co-uses', () => {
    const w = world();
    const deploy = w.store('Deploy the web service with the blue green script.', 'procedure');
    const region = w.store('Production runs in the eu-west-1 region.', 'fact');
    const status = w.store('The status page is updated after each deploy.', 'fact');
    w.task([deploy, region]);
    w.task([deploy, status], false);
    expect(listPremiseHolds(w.db).holds).toEqual([]);
    w.db.correct(region.id, { text: 'Production runs in the us-east-1 region.', source: { uri: 'test:region-v2' }, reason: 'Region moved.' });
    w.db.correct(status.id, { text: 'The status page is retired.', source: { uri: 'test:status-v2' }, reason: 'Retired.' });
    const before = w.db.ledger({ limit: 1000 }).entries.length;
    const listed = listPremiseHolds(w.db);
    // A failed co-use never holds; the successful one does, at support 1.
    expect(listed.holds.map(hold => [hold.from, hold.to, hold.support])).toEqual([[deploy.id, region.id, 1]]);
    expect(createPremiseGuard(w.db).holds(deploy.id).map(hold => hold.premiseId)).toEqual([region.id]);
    expect(w.db.ledger({ limit: 1000 }).entries.length).toBe(before);
    expect(() => inferDependencies(w.db, { minSupport: 1 })).toThrow('minSupport');
  });

  it('accepts a hold on an active but ineligible premise by linking it, so the kernel withholds the dependent', () => {
    const w = world();
    const deploy = w.store('Deploy the web service with the blue green script.', 'procedure');
    const region = w.store('Production runs in the eu-west-1 region.', 'fact');
    w.task([deploy, region]);
    w.db.recordOutcome({ memoryId: region.id, success: false, evidence: 'Region lookup failed.', verifier: 'harness', taskId: 'probe-1' });
    const [hold] = listPremiseHolds(w.db).holds;
    expect(hold).toMatchObject({ from: deploy.id, to: region.id, hold: { reason: 'premise-ineligible', premiseStatus: 'active', linkTo: region.id } });
    expect(() => reviewDependency(w.db, { ...hold, support: 2 }, 'accept', 'ops-lead')).toThrow('digest');
    const review = reviewDependency(w.db, hold, 'accept', 'ops-lead', { now: w.now });
    expect(w.db.get(review.dependentId)?.dependencies).toEqual([region.id]);
    expect(w.db.isEligible(review.dependentId)).toBe(false);
    expect(createPremiseGuard(w.db).allows(review.dependentId)).toBe(true);
    expect(listPremiseHolds(w.db).holds).toEqual([]);
  });

  it('accepts a held skill by linking the premise\'s current version; the next correction retires it', async () => {
    const w = world();
    const evidence = w.store('The release checklist has five steps.', 'fact');
    const premise = w.store('Release tags are signed with the project key.', 'fact');
    const created = w.runtime.createSkill({ name: 'Release', prerequisites: [], steps: ['Run the checklist', 'Sign the tag'], parameters: {}, evidenceIds: [evidence.id] });
    const active = await w.runtime.trialSkill({ id: created.id, validation: { passed: true, evidence: 'Synthetic trial passed.', verifier: 'harness', taskId: 'trial-1', prerequisitesSatisfied: true } });
    w.task([w.db.get(active.recordId)!, premise, evidence]);
    const v2 = w.db.correct(premise.id, { text: 'Release tags are signed with the release key.', source: { uri: 'test:tags-v2' }, reason: 'Key rotated.' });
    expect(createPremiseGuard(w.db).skill(w.runtime.getSkill(created.id))?.state).toBe('retired');
    const [hold] = listPremiseHolds(w.db).holds;
    expect(hold).toMatchObject({ from: active.recordId, to: premise.id, skillId: created.id, support: 1, hold: { linkTo: v2.id } });
    const review = reviewDependency(w.db, hold, 'accept', 'ops-lead', { runtime: w.runtime, now: w.now });
    expect(w.runtime.getSkill(created.id)).toMatchObject({ state: 'active', recordId: review.dependentId, premises: [{ memoryId: v2.id, receiptId: review.receiptId }] });
    expect(createPremiseGuard(w.db).skill(w.runtime.getSkill(created.id))?.state).toBe('active');
    w.db.correct(v2.id, { text: 'Release tags are unsigned.', source: { uri: 'test:tags-v3' }, reason: 'Policy changed.' });
    expect(w.runtime.getSkill(created.id)).toMatchObject({ state: 'retired' });
  });

  it('refuses to accept a hold whose premise has no current version, and requires a note to release one', () => {
    const w = world();
    const base = w.store('The fleet uses region codes from the cloud catalogue.', 'fact');
    const region = w.db.store({ text: 'Production runs in the eu-west-1 region.', kind: 'fact', trust: 'observed', source: { uri: 'test:region' }, dependencies: [base.id] });
    const deploy = w.store('Deploy the web service with the blue green script.', 'procedure');
    w.task([deploy, region]);
    w.db.correct(base.id, { text: 'The fleet uses its own region codes.', source: { uri: 'test:base-v2' }, reason: 'Catalogue dropped.' });
    const [hold] = listPremiseHolds(w.db).holds;
    expect(hold).toMatchObject({ from: deploy.id, to: region.id, hold: { reason: 'premise-changed', premiseStatus: 'invalidated' } });
    expect(hold.hold?.linkTo).toBeUndefined();
    expect(() => reviewDependency(w.db, hold, 'accept', 'ops-lead')).toThrow('no current version');
    expect(() => reviewDependency(w.db, hold, 'reject', 'ops-lead')).toThrow('requires a note');
    reviewDependency(w.db, hold, 'reject', 'ops-lead', { note: 'Deploy does not read the region.' });
    expect(createPremiseGuard(w.db).allows(deploy.id)).toBe(true);
  });
});
