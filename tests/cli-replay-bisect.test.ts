import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalMemory, type SyncMemoryEmbedder } from '../src/local/index.js';
import { BUNDLED_EMBEDDING_ID, bundledModelStatus } from '../src/local/embedding/index.js';
import { bundledRerankerStatus } from '../src/local/reranking/model-assets.js';
import { hnswAvailable } from '../src/local/vector/index.js';
import { gatedDescribe, gatedIt } from './env-gates.js';

/**
 * The `replay` and `bisect` CLI routes.
 *
 * Both read-only, and neither may exist for a caller who does not ask for it:
 * the surface here is exactly the surface the help text promises, and nothing
 * else changes shape.
 */

const cli = resolve('dist/cli/index.js');
const directories: string[] = [];
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const iso = (millis: number): string => new Date(millis).toISOString();

afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { db: string; scope: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-cli-replay-'));
  directories.push(root);
  const db = join(root, 'memory.sqlite');
  const clock = { value: T0 };
  const memory = createLocalMemory({ path: db, workspaceId: 'replay-cli', agentId: 'controller', now: () => new Date(clock.value) });
  try {
    const policy = memory.store({ text: 'the deployment window is Tuesday', kind: 'decision', source: { uri: 'doc://runbook-v1' } });
    // Held across both cut points, so the diff below has to be about the correction alone.
    memory.store({ text: 'an unrelated observation', source: { uri: 'doc://notes' } });
    clock.value = T0 + 20 * DAY;
    memory.correct(policy.id, { text: 'the deployment window is Thursday', source: { uri: 'doc://runbook-v2' }, reason: 'schedule change' });
  } finally { memory.close(); }
  return { db, scope: ['--db', db, '--workspace', 'replay-cli', '--agent', 'controller'] };
}

function run(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Every case here spawns real CLI processes; under a fully parallel `npm run
// check` on a shared machine that is seconds, not milliseconds.
describe('mnemosy replay', { timeout: 60_000 }, () => {
  it('reconstructs a belief state and reports the hash with its exclusions', () => {
    const f = fixture();
    const result = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY)]);
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(state.algorithm).toBe('mnemosyne-replay-state-v1');
    expect(state.cut).toEqual({ asOf: iso(T0 + DAY), knownAt: iso(T0 + DAY) });
    expect(state.stateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.records).toBe(2);
    expect(state.excluded).toContain('local_ledger');
    // The record bodies are not printed unless asked for: a 10k state is not console output.
    expect(state.items).toBeUndefined();
  });

  it('prints the digest alone under --hash, for scripting', () => {
    const f = fixture();
    const full = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY)]);
    const bare = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--hash']);
    expect(bare.status, bare.stderr).toBe(0);
    expect(bare.stdout.trim()).toBe((JSON.parse(full.stdout) as { stateSha256: string }).stateSha256);
    expect(bare.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same cut point on a second invocation', () => {
    const f = fixture();
    const args = ['replay', ...f.scope, '--known-at', iso(T0 + 30 * DAY), '--as-of', iso(T0 + 10 * DAY), '--hash'];
    expect(run(args).stdout).toBe(run(args).stdout);
  });

  it('reads the belief held at a past cut point, not the current one', () => {
    const f = fixture();
    const before = JSON.parse(run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--records']).stdout) as { items: { text: string }[] };
    const after = JSON.parse(run(['replay', ...f.scope, '--known-at', iso(T0 + 30 * DAY), '--records']).stdout) as { items: { text: string }[] };
    expect(before.items.map(item => item.text)).toContain('the deployment window is Tuesday');
    expect(before.items.map(item => item.text)).not.toContain('the deployment window is Thursday');
    expect(after.items.map(item => item.text)).toContain('the deployment window is Thursday');
    expect(after.items.map(item => item.text)).not.toContain('the deployment window is Tuesday');
  });

  it('diffs two cut points and names the source of each change', () => {
    const f = fixture();
    const result = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--diff', iso(T0 + 30 * DAY),
      '--json', JSON.stringify({ knownAt: iso(T0 + 30 * DAY) })]);
    expect(result.status, result.stderr).toBe(0);
    const diff = JSON.parse(result.stdout) as {
      from: { stateSha256: string }; to: { stateSha256: string };
      added: { text: string; source: { uri: string }; ledger: { event: string }[] }[];
      removed: { text: string; source: { uri: string } }[];
    };
    expect(diff.from.stateSha256).not.toBe(diff.to.stateSha256);
    const correction = diff.added.find(entry => entry.text === 'the deployment window is Thursday');
    expect(correction?.source.uri).toBe('doc://runbook-v2');
    expect(correction?.ledger.map(entry => entry.event)).toContain('correction');
    expect(diff.removed.find(entry => entry.text === 'the deployment window is Tuesday')?.source.uri).toBe('doc://runbook-v1');
  });

  it('requires --known-at and rejects a malformed cut point', () => {
    const f = fixture();
    const missing = run(['replay', ...f.scope]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--known-at');
    const malformed = run(['replay', ...f.scope, '--known-at', 'last tuesday']);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('ISO timestamp');
    expect(malformed.stdout).toBe('');
  });

  it('is refused under --no-recall and never treated as a write', () => {
    const f = fixture();
    const denied = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--no-recall']);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('disabled by --no-recall');
    // read-only is a read route's normal mode, not a denial.
    expect(run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--read-only', '--hash']).status).toBe(0);
  });

  it('appears in --help', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('mnemosy replay [scope]');
    expect(help.stdout).toContain('mnemosy bisect [scope]');
  });

  it('never lets an allowlisted command succeed silently', () => {
    // A command in COMMAND_ACCESS with no switch arm passes the unknown-command
    // guard, falls through, and exits 0 with no output — which reads as success.
    // `bisect` shipped that way once. Both halves are pinned: an unknown command
    // is refused, and every advertised command produces output or an error.
    const f = fixture();
    const unknown = run(['frobnicate', ...f.scope]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown command: frobnicate');
    for (const command of ['replay', 'bisect']) {
      const bare = run([command, ...f.scope]);
      expect(bare.status, `${command} exited ${bare.status}`).toBe(1);
      expect(bare.stdout).toBe('');
      expect(bare.stderr).not.toBe('');
    }
  });
});

describe('mnemosy bisect', { timeout: 60_000 }, () => {
  /** A store where two unattributed claims outrank the sourced answer. */
  function poisoned(): { scope: string[]; tasks: string; gold: string; poison: string[]; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-cli-bisect-'));
    directories.push(root);
    const db = join(root, 'memory.sqlite');
    const memory = createLocalMemory({ path: db, workspaceId: 'bisect-cli', agentId: 'auditor', retrieval: 'lexical', now: () => new Date(T0) });
    let gold = '';
    const poison: string[] = [];
    try {
      gold = memory.store({
        text: 'the incident review was signed off by the platform team',
        kind: 'fact', trust: 'verified', evidence: 'review://signoff', source: { uri: 'doc://review' },
      }).id;
      for (let index = 0; index < 2; index++) {
        poison.push(memory.store({ text: 'the incident review was signed off', trust: 'observed', source: { uri: `doc://rumour-${index}` } }).id);
      }
    } finally { memory.close(); }
    const tasks = join(root, 'tasks.json');
    writeFileSync(tasks, JSON.stringify([{ id: 'incident', query: 'incident review signed off', k: 1, gold: [gold] }]));
    return { scope: ['--db', db, '--workspace', 'bisect-cli', '--agent', 'auditor'], tasks, gold, poison, root };
  }

  it('reports the minimal blame set for a task in a task file', () => {
    const f = poisoned();
    const result = run(['bisect', ...f.scope, '--file', f.tasks, '--task', 'incident']);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { outcome: string; reason: string; blame: string[]; exactConfirmed: boolean; elapsedMs: number };
    expect(report.outcome).toBe('blamed');
    expect(report.reason).toBe('displaced');
    expect([...report.blame].sort()).toEqual([...f.poison].sort());
    expect(report.blame).not.toContain(f.gold);
    expect(report.exactConfirmed).toBe(true);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('takes a task inline and judges it at --limit', () => {
    const f = poisoned();
    const task = JSON.stringify({ id: 'inline', query: 'incident review signed off', gold: [f.gold] });
    const passing = run(['bisect', ...f.scope, '--json', task, '--limit', '10']);
    expect(passing.status, passing.stderr).toBe(0);
    expect((JSON.parse(passing.stdout) as { outcome: string }).outcome).toBe('passing');
    const failing = run(['bisect', ...f.scope, '--json', task, '--limit', '1']);
    expect((JSON.parse(failing.stdout) as { outcome: string }).outcome).toBe('blamed');
  });

  it('refuses an unknown task id, a missing task file and a malformed task', () => {
    const f = poisoned();
    const missing = run(['bisect', ...f.scope, '--file', f.tasks, '--task', 'nope']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('No bisect task with id nope');
    expect(run(['bisect', ...f.scope, '--file', f.tasks]).stderr).toContain('--task');
    const malformed = run(['bisect', ...f.scope, '--json', JSON.stringify({ id: 'x', query: 'y' })]);
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe('');
  });

  it('is refused under --no-recall and allowed under --read-only', () => {
    const f = poisoned();
    const denied = run(['bisect', ...f.scope, '--file', f.tasks, '--task', 'incident', '--no-recall']);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('disabled by --no-recall');
    expect(run(['bisect', ...f.scope, '--file', f.tasks, '--task', 'incident', '--read-only']).status).toBe(0);
  });
});

/** The parts of a CLI bisect report the retrieval cases read. */
interface CliBisectReport {
  outcome: string; blame: string[]; exactConfirmed: boolean | null; exactRetrieval: string | null;
  exactConfig: { mode: string; embeddingModel: string | null; index: string | null } | null;
  retrievalSelection: { requested: string; mode: string; signal: string };
}

const SAILBOAT_NOTES = [
  'The quarterly invoice for the printer lease was paid on Tuesday.',
  'Priya prefers green tea over coffee in the afternoon.',
  'The bicycle needs a new rear tyre before the race.',
  'Weather on the coast turned stormy by the weekend.',
  'Marco is learning to play the cello at evening classes.',
  'The garden fence was painted dark blue last spring.',
  'Our team retrospective moved to Thursday mornings.',
  'The library returns desk closes at six on Fridays.',
  'Lena booked a cabin by the lake for August.',
  'The kitchen tap has been dripping since Monday.',
  'Sam adopted a grey cat called Pepper from the shelter.',
  'The museum exhibition on maps opens next month.',
  'Our backup server runs its nightly job at two a.m.',
  'The bakery on Elm Street sells rye bread on Saturdays.',
  'Jonas ran his first half marathon in under two hours.',
  'The harbour master inspects moorings every April.',
  'Dana repainted the hull of her boat in May.',
];

/**
 * Stored vectors under the bundled model's identity, made without the model: a
 * hashed bag of words at its width. Only for the cases that never load the model.
 */
function bundledLookalike(): SyncMemoryEmbedder {
  const dimensions = 384;
  const vector = (text: string): number[] => {
    const out = new Array<number>(dimensions).fill(0.01);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 0;
      for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      out[hash % dimensions] += 1;
    }
    return out;
  };
  const view = () => ({ model: BUNDLED_EMBEDDING_ID, dimensions, embed: async (texts: readonly string[]) => texts.map(vector) });
  return { model: BUNDLED_EMBEDDING_ID, dimensions, embedSync: (texts) => texts.map(vector), embed: async (texts) => texts.map(vector), forQueries: view, forPassages: view, close: () => {} };
}

/**
 * The sailboat store of tests/local-bisect-hybrid.test.ts, in a file: a sourced
 * answer outranked by a short unsourced claim. `recall` decides how it was used:
 * a hybrid store has run a hybrid recall, so its records carry stored vectors.
 */
function sailboat(options: { retrieval: 'hybrid' | 'lexical'; embedder?: SyncMemoryEmbedder; indexMode?: 'exact' | 'hnsw' }): { scope: string[]; task: string; gold: string; poison: string } {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-cli-bisect-hybrid-'));
  directories.push(root);
  const db = join(root, 'memory.sqlite');
  const memory = createLocalMemory({
    path: db, workspaceId: 'bisect-hybrid-cli', agentId: 'auditor', retrieval: options.retrieval, now: () => new Date(T0),
    ...(options.embedder ? { embedder: options.embedder, rerank: false } : {}), ...(options.indexMode ? { indexMode: options.indexMode } : {}),
  });
  let gold = '', poison = '';
  try {
    SAILBOAT_NOTES.forEach((text, index) => memory.store({ text, trust: 'observed', source: { uri: `test://note/${index}` } }));
    gold = memory.store({
      text: 'Dana named her sailboat Corvina after the summer refit at the boatyard.',
      kind: 'fact', trust: 'verified', evidence: 'transcript://session-4', source: { uri: 'test://transcript/gold' },
    }).id;
    poison = memory.store({ text: 'Dana named the sailboat Mistral.', trust: 'observed', source: { uri: 'test://rumour/0' } }).id;
    // The agent's own recall: on hybrid this is what writes the stored vectors.
    memory.recall({ query: 'What did Dana name the sailboat?', limit: 5 });
  } finally { memory.close(); }
  const task = JSON.stringify({ id: 'sailboat', query: 'What did Dana name the sailboat?', k: 1, gold: [gold], depth: 20 });
  return { scope: ['--db', db, '--workspace', 'bisect-hybrid-cli', '--agent', 'auditor'], task, gold, poison };
}

describe('mnemosy bisect --retrieval, without a model', { timeout: 60_000 }, () => {
  it('reports the lexical path for a store that has no stored vectors, and refuses an unknown mode', () => {
    const f = sailboat({ retrieval: 'lexical' });
    const auto = run(['bisect', ...f.scope, '--json', f.task]);
    expect(auto.status, auto.stderr).toBe(0);
    const report = JSON.parse(auto.stdout) as CliBisectReport;
    expect(report.retrievalSelection).toMatchObject({ requested: 'auto', mode: 'lexical' });
    expect(report.exactRetrieval).toBe('lexical');
    const bogus = run(['bisect', ...f.scope, '--json', f.task, '--retrieval', 'dense']);
    expect(bogus.status).toBe(1);
    expect(bogus.stdout).toBe('');
    expect(bogus.stderr).toContain('--retrieval must be auto, lexical or hybrid');
  });

  it('chooses hybrid for a store with stored vectors, and fails loudly rather than bisect lexically when the model is missing', () => {
    const f = sailboat({ retrieval: 'hybrid', embedder: bundledLookalike() });
    const empty = mkdtempSync(join(tmpdir(), 'mnemosyne-no-models-'));
    directories.push(empty);
    const missing = { MNEMOSYNE_MODEL_CACHE: empty };
    for (const args of [[], ['--retrieval', 'auto'], ['--retrieval', 'hybrid']]) {
      const result = run(['bisect', ...f.scope, '--json', f.task, ...args], missing);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`bisect needs the hybrid retriever (${args.length ? args[1] : 'auto'}`);
      expect(result.stderr).toContain('--retrieval lexical');
    }
    // Asked for explicitly, the lexical path still runs on the same store.
    const lexical = run(['bisect', ...f.scope, '--json', f.task, '--retrieval', 'lexical'], missing);
    expect(lexical.status, lexical.stderr).toBe(0);
    const report = JSON.parse(lexical.stdout) as CliBisectReport;
    expect(report.retrievalSelection).toMatchObject({ requested: 'lexical', mode: 'lexical' });
    expect(report.exactConfig?.mode ?? 'lexical').toBe('lexical');
  });
});

const withModels = gatedDescribe('model', bundledModelStatus().present && bundledRerankerStatus().present);

withModels('mnemosy bisect on the default hybrid path', () => {
  it('bisects a hybrid store on hybrid by default, with Oracle B re-running the same retriever', { timeout: 120_000 }, () => {
    const f = sailboat({ retrieval: 'hybrid' });
    for (const args of [[], ['--retrieval', 'hybrid']]) {
      const result = run(['bisect', ...f.scope, '--json', f.task, ...args]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as CliBisectReport;
      expect(report.retrievalSelection).toMatchObject({ requested: args.length ? 'hybrid' : 'auto', mode: 'hybrid' });
      expect(report.outcome).toBe('blamed');
      expect(report.blame).toEqual([f.poison]);
      expect(report.exactConfirmed).toBe(true);
      expect(report.exactRetrieval).toBe('hybrid');
      expect(report.exactConfig).toMatchObject({ mode: 'hybrid', embeddingModel: BUNDLED_EMBEDDING_ID });
      expect(['exact', 'sqlite-vec']).toContain(report.exactConfig?.index);
    }
  });

  it('still runs the lexical path on a hybrid store when asked to', { timeout: 120_000 }, () => {
    const f = sailboat({ retrieval: 'hybrid' });
    const result = run(['bisect', ...f.scope, '--json', f.task, '--retrieval', 'lexical']);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as CliBisectReport;
    expect(report.retrievalSelection).toMatchObject({ requested: 'lexical', mode: 'lexical' });
    expect(report.exactConfig?.mode ?? 'lexical').toBe('lexical');
  });

  gatedIt('hnsw', hnswAvailable())('refuses a store whose dense index is hnsw, with the kernel\'s reason', () => {
    const f = sailboat({ retrieval: 'hybrid', indexMode: 'hnsw' });
    const recorded = run(['bisect', ...f.scope, '--json', f.task]);
    expect(recorded.status).toBe(1);
    expect(recorded.stdout).toBe('');
    expect(recorded.stderr).toContain('bisect cannot reproduce an hnsw dense index');
    const named = run(['bisect', ...f.scope, '--json', f.task], { MNEMOSYNE_INDEX_MODE: 'hnsw' });
    expect(named.status).toBe(1);
    expect(named.stderr).toContain('bisect cannot reproduce an hnsw dense index');
  }, 120_000);
});
