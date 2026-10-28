import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import type { InferenceResult } from '../src/dependencies/index.js';

const directories: string[] = [];
const cli = resolve('dist/cli/index.js');
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-dependencies-cli-')); directories.push(root);
  return { root, db: join(root, 'memory.sqlite') };
}
type Fixture = ReturnType<typeof fixture>;
const scope = (f: Fixture) => ['--db', f.db, '--workspace', 'dependencies-test', '--agent', 'controller'];
function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, MNEMOSYNE_TOKEN: '' } });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); return result;
}
function fails(args: string[], message: string) {
  const result = invoke(args);
  expect(result.status, result.stdout).toBe(1); expect(result.stderr).toContain(message); expect(result.stdout).toBe('');
  return result;
}

/** Two procedures, each relying on an undeclared premise in three successful tasks (synthetic). */
function seed(f: Fixture) {
  const memory = createLocalMemory({ path: f.db, workspaceId: 'dependencies-test', agentId: 'controller', retrieval: 'lexical' });
  const runtime = new MemoryRuntime(memory);
  const store = (text: string, kind: 'fact' | 'procedure') => memory.store({ text, kind, trust: 'observed', source: { uri: `test://dependencies/${kind}/${text.length}` } });
  try {
    const deploy = store('Deploy the web service with the blue green script.', 'procedure');
    const region = store('Production runs in the eu-west-1 region.', 'fact');
    const backup = store('Back up the ledger database to the archive bucket nightly.', 'procedure');
    const bucket = store('The archive bucket is named ledger-archive-7.', 'fact');
    const other = store('Rotate the service credentials with the vault tool.', 'procedure');
    const vault = store('The vault tool requires a hardware key.', 'fact');
    let serial = 0;
    const task = (records: MemoryRecord[], used: MemoryRecord[]) => {
      memory.recall({ query: records.map(record => record.text).join(' '), limit: 10 });
      runtime.recordTrace({ taskId: `task-${++serial}`, query: 'synthetic', retrievedIds: records.map(record => record.id), usedIds: used.map(record => record.id), outcome: { success: true, evidence: `Synthetic evidence ${serial}.`, verifier: 'harness' } });
    };
    for (let index = 0; index < 6; index++) task([other, vault], [other]);
    for (let index = 0; index < 3; index++) { task([deploy, region], [deploy, region]); task([backup, bucket], [backup, bucket]); }
    return { deploy: deploy.id, region: region.id, backup: backup.id, bucket: bucket.id };
  } finally { memory.close(); }
}
function infer(f: Fixture, extra: string[] = []): InferenceResult {
  const result = invoke(['dependencies', ...scope(f), '--infer', ...extra]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as InferenceResult;
}

describe('mnemosy dependencies', () => {
  it('documents both modes in --help', () => {
    const result = invoke(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('mnemosy dependencies [scope] --infer [--min-support N]');
    expect(result.stdout).toContain('mnemosy dependencies [scope] --review DIGEST --accept|--reject --reviewer NAME');
  });

  it('infers read-only, then ledgers a reject and an accept by digest', () => {
    const f = fixture(), ids = seed(f);
    const shown = infer(f, ['--read-only', '--no-capture']);
    const pairs = shown.proposals.map(proposal => [proposal.from, proposal.to]).sort();
    expect(pairs).toEqual([[ids.deploy, ids.region], [ids.backup, ids.bucket]].sort());
    expect(infer(f, ['--min-support', '4']).proposals).toEqual([]);
    expect(infer(f, ['--json', '{"minSupport":4}']).proposals).toEqual([]);

    const deploy = shown.proposals.find(proposal => proposal.from === ids.deploy)!;
    const backup = shown.proposals.find(proposal => proposal.from === ids.backup)!;
    const rejected = invoke(['dependencies', ...scope(f), '--review', deploy.digest, '--reject', '--reviewer', 'ops-lead', '--reason', 'Region is incidental.']);
    expect(rejected.status, rejected.stderr).toBe(0);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ decision: 'reject', digest: deploy.digest, dependentId: ids.deploy });
    const accepted = invoke(['dependencies', ...scope(f), '--review', backup.digest, '--accept', '--reviewer', 'ops-lead']);
    expect(accepted.status, accepted.stderr).toBe(0);
    const review = JSON.parse(accepted.stdout) as { decision: string; dependentId: string; supersededId: string; receiptId: string };
    expect(review).toMatchObject({ decision: 'accept', supersededId: ids.backup });

    // Reviewed pairs leave the queue; a stale digest is refused rather than guessed.
    expect(infer(f).proposals).toEqual([]);
    fails(['dependencies', ...scope(f), '--review', backup.digest, '--accept', '--reviewer', 'ops-lead'], 'No current proposal has that digest');

    const memory = createLocalMemory({ path: f.db, workspaceId: 'dependencies-test', agentId: 'controller', retrieval: 'lexical' });
    try {
      const receipts = memory.ledger({ events: ['dependency'] }).entries;
      expect(receipts.map(entry => entry.dependency?.decision).sort()).toEqual(['accept', 'reject']);
      expect(receipts.find(entry => entry.dependency?.decision === 'reject')?.dependency).toMatchObject({ reviewer: 'ops-lead', note: 'Region is incidental.' });
      expect(memory.get(review.dependentId)?.dependencies).toContain(ids.bucket);
      expect(memory.get(ids.deploy)?.dependencies ?? []).not.toContain(ids.region);
      memory.correct(ids.bucket, { text: 'The archive bucket is named ledger-archive-8.', source: { uri: 'test://dependencies/fix' }, reason: 'Bucket renamed.' });
      expect(memory.get(review.dependentId)?.status).toBe('invalidated');
      expect(memory.get(ids.deploy)?.status).toBe('active');
    } finally { memory.close(); }
  });

  it('denies review writes and recall-less inference before SQLite is created', () => {
    const f = fixture(), digest = 'a'.repeat(64);
    for (const flag of ['--read-only', '--no-capture']) {
      fails(['dependencies', ...scope(f), '--review', digest, '--accept', '--reviewer', 'ops-lead', flag], `disabled by ${flag}`);
    }
    fails(['dependencies', ...scope(f), '--infer', '--no-recall'], 'disabled by --no-recall');
    fails(['dependencies', ...scope(f), '--review', digest, '--reject', '--reviewer', 'ops-lead', '--no-recall'], 'disabled by --no-recall');
    expect(readdirSync(f.root)).toEqual([]);
  });

  it('rejects malformed invocations before SQLite is created', () => {
    const f = fixture(), digest = 'b'.repeat(64);
    const cases: [string[], string][] = [
      [[], 'exactly one of --infer or --review'],
      [['--infer', '--review', digest], 'exactly one of --infer or --review'],
      [['--infer', '--reviewer', 'ops-lead'], 'Unsupported option'],
      [['--infer', '--action', 'infer'], 'does not support --action'],
      [['--infer', '--min-support', '1'], 'at least 2'],
      [['--infer', '--min-support', 'two'], 'positive integers'],
      [['--infer', '--json', '[]'], 'must contain an object'],
      [['--review', 'not-a-digest', '--accept', '--reviewer', 'ops-lead'], 'proposal digest'],
      [['--review', digest, '--reviewer', 'ops-lead'], 'exactly one of --accept or --reject'],
      [['--review', digest, '--accept', '--reject', '--reviewer', 'ops-lead'], 'exactly one of --accept or --reject'],
      [['--review', digest, '--accept'], '--reviewer is required'],
    ];
    for (const [args, message] of cases) fails(['dependencies', ...scope(f), ...args], message);
    expect(readdirSync(f.root)).toEqual([]);
  });

  it('refuses a review digest that names no current proposal', () => {
    const f = fixture(); seed(f);
    fails(['dependencies', ...scope(f), '--review', 'c'.repeat(64), '--accept', '--reviewer', 'ops-lead'], 'No current proposal has that digest');
    const memory = createLocalMemory({ path: f.db, workspaceId: 'dependencies-test', agentId: 'controller', retrieval: 'lexical' });
    try { expect(memory.ledger({ events: ['dependency'] }).entries).toEqual([]); } finally { memory.close(); }
  });
});
