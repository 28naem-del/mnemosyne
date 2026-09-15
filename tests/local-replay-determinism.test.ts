import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalMemory, type LocalMemory, type SyncMemoryEmbedder } from '../src/local/index.js';
import { replayState } from '../src/local/replay.js';
import { applyTimelinePlan, buildTimelinePlan, expectedFactAt, iso, randomCutPoints, type TimelinePlan } from './fixtures/timeline-corpus.js';

/**
 * The §11.7 moment-1 proof gate: **replay determinism**.
 *
 * Identical state hash at 1000 random `(asOf, knownAt)` cut points, and the
 * as-of answer matches ground truth on a seeded timeline corpus.
 *
 * "Identical" is asserted ACROSS PROCESSES. Recomputing a hash inside one
 * process proves almost nothing — the module graph, the SQLite connection, the
 * statement cache and any memoized clock are all shared. So the gate spawns
 * `scripts/replay-cut-hashes.mjs` as real child processes and diffs their
 * stdout, and repeats that after the database has been physically rewritten by
 * `VACUUM`.
 *
 * Ground truth comes from the fixture PLAN, never from the store: see
 * `expectedFactAt` in `tests/fixtures/timeline-corpus.ts`.
 */

const CUT_POINTS = 1000;
/**
 * Generous per-test budget. Each of these cases replays 1000 cut points one to
 * three times, some of it in spawned processes, and the suite shares a 24 GB
 * machine with the rest of `npm run check` running in parallel. The gate is
 * "identical", not "fast" — the measured wall time is recorded in progress.md.
 */
const BUDGET = 120_000;
const SCRIPT = resolve('scripts/replay-cut-hashes.mjs');
const WORKSPACE = 'v0-timeline';
const AGENT = 'replayer';

let root: string;
let database: string;
let cutFile: string;
let plan: TimelinePlan;
let cuts: { asOf: string; knownAt: string }[];
let memory: LocalMemory;
let records: number;

function stubEmbedder(): SyncMemoryEmbedder {
  const vector = (text: string): number[] => {
    const out = new Array<number>(8).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) out[createHash('sha256').update(token).digest()[0] % 8] += 1;
    const norm = Math.hypot(...out) || 1;
    return out.map(value => value / norm);
  };
  const embedSync = (texts: readonly string[]): number[][] => texts.map(vector);
  const self: SyncMemoryEmbedder = {
    model: 'test-stub-embedder@v1', dimensions: 8, embedSync,
    embed: async (texts: readonly string[]) => embedSync(texts),
    forQueries: () => self, forPassages: () => self, close: () => {},
  };
  return self;
}

/** One child process per call. Returns one hash per cut point, in order. */
function hashesFromChildProcess(): string[] {
  const output = execFileSync(process.execPath, [SCRIPT, '--db', database, '--workspace', WORKSPACE, '--agent', AGENT, '--cuts', cutFile], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return output.trimEnd().split('\n');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mnemosyne-replay-determinism-'));
  database = join(root, 'timeline.sqlite');
  cutFile = join(root, 'cuts.json');
  plan = buildTimelinePlan();
  cuts = randomCutPoints(plan, CUT_POINTS);
  writeFileSync(cutFile, JSON.stringify(cuts));
  const clock = { value: plan.bounds.start };
  memory = createLocalMemory({ path: database, workspaceId: WORKSPACE, agentId: AGENT, now: () => new Date(clock.value) });
  records = applyTimelinePlan(memory, plan, clock).total;
}, BUDGET);

afterAll(() => {
  memory?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('replay determinism at 1000 cut points', () => {
  it('has a corpus with real bitemporal structure to replay', () => {
    expect(records).toBeGreaterThan(80);
    expect(cuts).toHaveLength(CUT_POINTS);
    expect(new Set(cuts.map(cut => `${cut.asOf}|${cut.knownAt}`)).size).toBeGreaterThan(CUT_POINTS * 0.9);
    // Knowledge that arrived after the fact is the case where the two axes differ.
    expect(plan.facts.some(fact => fact.versions.some(version => version.knownFrom > version.validFrom))).toBe(true);
  });

  it('gives byte-identical state hashes in two independent processes', () => {
    if (!existsSync(resolve('dist/local/replay.js'))) throw new Error('run `npm run build` first — the cross-process gate reads dist/');
    const first = hashesFromChildProcess();
    const second = hashesFromChildProcess();
    expect(first).toHaveLength(CUT_POINTS);
    expect(second).toHaveLength(CUT_POINTS);
    const matches = first.filter((hash, index) => hash === second[index]).length;
    expect(matches).toBe(CUT_POINTS);
    // A corpus whose every cut point hashes the same would pass trivially.
    expect(new Set(first).size).toBeGreaterThan(10);
    expect(first.every(hash => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  }, BUDGET);

  it('agrees with an in-process replay of the same cut points', () => {
    const child = hashesFromChildProcess();
    const inProcess = cuts.map(cut => replayState(memory, cut).stateSha256);
    expect(inProcess.filter((hash, index) => hash === child[index]).length).toBe(CUT_POINTS);
  }, BUDGET);

  it('as-of answers match ground truth computed from the plan, not from the store', () => {
    let checked = 0;
    let presentCases = 0;
    for (const cut of cuts.slice(0, 120)) {
      const asOf = Date.parse(cut.asOf);
      const knownAt = Date.parse(cut.knownAt);
      const state = replayState(memory, cut, { records: true });
      const byEntity = new Map<string, string[]>();
      for (const record of state.items ?? []) {
        const entity = record.metadata.entity;
        if (typeof entity === 'string') byEntity.set(entity, [...(byEntity.get(entity) ?? []), record.text]);
      }
      for (const fact of plan.facts) {
        const expected = expectedFactAt(fact, asOf, knownAt);
        const actual = byEntity.get(fact.entity) ?? [];
        if (expected === null) expect(actual).toEqual([]);
        else { expect(actual).toEqual([expected.text]); presentCases++; }
        checked++;
      }
    }
    expect(checked).toBe(120 * plan.facts.length);
    expect(presentCases).toBeGreaterThan(100);
  }, BUDGET);

  it('reads the old value before the change date and the new value after it', () => {
    // The plain-language version of the gate, on one fact, at four cut points.
    const fact = plan.facts.find(entry => entry.versions.length >= 2 && entry.versions[1].knownFrom === entry.versions[1].validFrom) ?? plan.facts[0];
    const change = fact.versions[1];
    const before = { asOf: iso(change.validFrom - 1), knownAt: iso(plan.bounds.end) };
    const after = { asOf: iso(change.validFrom), knownAt: iso(plan.bounds.end) };
    const textAt = (cut: { asOf: string; knownAt: string }): string[] =>
      (replayState(memory, cut, { records: true }).items ?? []).filter(record => record.metadata.entity === fact.entity).map(record => record.text);

    expect(textAt(before)).toEqual([fact.versions[0].text]);
    expect(textAt(after)).toEqual([change.text]);

    // And the transaction axis is independent: as-of AFTER the change but
    // known-at BEFORE we learned it still reads the older belief.
    const notYetKnown = { asOf: iso(change.validFrom), knownAt: iso(change.knownFrom - 1) };
    expect(textAt(notYetKnown)).toEqual(expectedFactAt(fact, change.validFrom, change.knownFrom - 1) === null ? [] : [expectedFactAt(fact, change.validFrom, change.knownFrom - 1)!.text]);
  });

  it('answers a recall at a past cut point with the belief held then', () => {
    const fact = plan.facts[3];
    for (const version of fact.versions) {
      const cut = { asOf: iso(version.validFrom + 1), knownAt: iso(plan.bounds.end) };
      const hits = memory.recall({ query: `${fact.entity} lives`, limit: 25, ...cut })
        .filter(hit => hit.memory.metadata.entity === fact.entity);
      const expected = expectedFactAt(fact, version.validFrom + 1, plan.bounds.end);
      expect(expected).not.toBeNull();
      expect(hits.map(hit => hit.memory.text)).toEqual([expected!.text]);
    }
  });

  it('survives a compaction pass: VACUUM, REINDEX, ANALYZE and a cache rebuild do not move a hash', async () => {
    const before = hashesFromChildProcess();

    // A derived-cache write first: embeddings are excluded from the state by
    // design, and this is where that claim gets tested rather than asserted.
    await memory.indexEmbeddings({ embedder: stubEmbedder() });
    memory.close();

    const raw = new DatabaseSync(database);
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    raw.exec('REINDEX;');
    raw.exec('ANALYZE;');
    raw.exec('VACUUM;');
    raw.close();

    const after = hashesFromChildProcess();
    expect(after).toHaveLength(CUT_POINTS);
    expect(after.filter((hash, index) => hash === before[index]).length).toBe(CUT_POINTS);

    // Reopen for any later case in the file.
    memory = createLocalMemory({ path: database, workspaceId: WORKSPACE, agentId: AGENT });
    expect(replayState(memory, cuts[0]).stateSha256).toBe(before[0]);
  }, BUDGET);
});
