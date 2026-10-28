/**
 * Moment 1 — "It remembers, and knows why."
 *
 * The user asks what the store believed on a past date and gets the exact prior
 * belief, the diff that changed it, and the source and reason of that change.
 *
 * Proof (measured live): replay determinism. The belief state is hashed at N
 * seeded `(asOf, knownAt)` cut points twice — once in this process on the live
 * connection, once in a SEPARATE node process that opens the same database file
 * cold — and the two hash lists are compared. Same-process repetition alone would
 * share the module graph, the SQLite connection and its statement cache, so it
 * would prove little. Every keyed fact's as-of answer at every cut point is also
 * compared with the seeded plan's ground truth.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalMemory, type LocalMemory } from '../../local/index.js';
import { replayDiff, replayState } from '../../local/replay.js';
import { buildTimelinePlan, day, expectedVersionAt, iso, randomCutPoints, type TimelinePlan } from './corpus.js';
import type { MomentContext, MomentOutcome } from './types.js';

const WORKSPACE = 'demo-orion';
const AGENT = 'historian';

/** Writes the plan in transaction-time order, moving the injected clock to each write. Returns the headline ids. */
function applyPlan(memory: LocalMemory, plan: TimelinePlan, clock: { value: number }): { before: string; after: string; total: number } {
  const placements: { at: number; apply: () => void }[] = [];
  let total = 0;
  const ids = { before: '', after: '' };
  for (const fact of plan.facts) {
    for (const version of fact.versions) {
      placements.push({ at: version.knownFrom, apply: () => {
        memory.store({
          text: version.text, kind: 'fact', key: fact.key, trust: 'verified',
          evidence: `synthetic://orion/inventory/${fact.entity}@${day(version.validFrom)}`,
          source: { uri: `synthetic://orion/inventory/${fact.entity}`, author: 'inventory-sync' },
          validFrom: iso(version.validFrom), ...(version.validUntil === undefined ? {} : { validUntil: iso(version.validUntil) }),
          metadata: { entity: fact.entity, value: version.value, synthetic: true },
        });
        total++;
      } });
    }
  }
  for (const note of plan.notes) placements.push({ at: note.createdAt, apply: () => { memory.store({ text: note.text, kind: 'observation', source: { uri: 'synthetic://orion/notes' } }); total++; } });
  for (const note of plan.untrusted) placements.push({ at: note.createdAt, apply: () => { memory.store({ text: note.text, kind: 'observation', trust: 'untrusted', source: { uri: 'synthetic://orion/pastes' } }); total++; } });
  const { headline } = plan;
  placements.push({ at: headline.before.at, apply: () => {
    ids.before = memory.store({ text: headline.before.text, kind: 'decision', key: headline.key, trust: 'observed', source: headline.before.source, metadata: { synthetic: true } }).id;
    total++;
  } });
  placements.push({ at: headline.after.at, apply: () => {
    ids.after = memory.correct(ids.before, { text: headline.after.text, source: headline.after.source, reason: headline.after.reason, validFrom: iso(headline.after.validFrom) }).id;
    total++;
  } });
  placements
    .map((placement, index) => ({ placement, index }))
    .sort((a, b) => a.placement.at - b.placement.at || a.index - b.index)
    .forEach(({ placement }) => { clock.value = placement.at; placement.apply(); });
  return { ...ids, total };
}

/**
 * The compiled kernel for the second, independent process. From `dist/` it is a
 * sibling; under vitest this module is the TypeScript source, so the build output
 * at the package root is used. `null` when there is no build to spawn.
 */
function compiledModules(): { local: string; replay: string } | null {
  const here = fileURLToPath(import.meta.url);
  const local = here.endsWith('.ts') ? resolve(here, '../../../../dist/local') : resolve(here, '../../../local');
  const index = join(local, 'index.js'), replay = join(local, 'replay.js');
  return existsSync(index) && existsSync(replay) ? { local: pathToFileURL(index).href, replay: pathToFileURL(replay).href } : null;
}

/** Read-only replay in a fresh node process: no ledger, the lexical path, so the replay cannot write to what it replays. */
const CHILD_MODULE = `
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const { createLocalMemory } = await import(input.local);
const { replayState } = await import(input.replay);
const memory = createLocalMemory({ path: input.path, workspaceId: input.workspace, agentId: input.agent, retrieval: 'lexical', ledger: false });
try { process.stdout.write(input.cuts.map((cut) => replayState(memory, cut).stateSha256).join('\\n') + '\\n'); } finally { memory.close(); }
`;

function hashesElsewhere(path: string, cuts: readonly { asOf: string; knownAt: string }[]): { hashes: string[]; mode: 'separate process' | 'fresh connection' } {
  const modules = compiledModules();
  if (modules) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_MODULE], {
      input: JSON.stringify({ ...modules, path, workspace: WORKSPACE, agent: AGENT, cuts }),
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    });
    if (run.status !== 0) throw new Error(`replay child process failed: ${(run.stderr || run.error?.message || 'no output').trim().split('\n')[0]}`);
    return { hashes: run.stdout.trimEnd().split('\n'), mode: 'separate process' };
  }
  // No compiled kernel to spawn (an unbuilt checkout): a fresh connection is the next most independent reader.
  const memory = createLocalMemory({ path, workspaceId: WORKSPACE, agentId: AGENT, retrieval: 'lexical', ledger: false });
  try { return { hashes: cuts.map((cut) => replayState(memory, cut).stateSha256), mode: 'fresh connection' }; } finally { memory.close(); }
}

export function momentRemembers(context: MomentContext): MomentOutcome {
  const { say } = context;
  const plan = buildTimelinePlan(context.seed);
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-demo-replay-'));
  const path = join(root, 'orion.sqlite');
  const clock = { value: plan.bounds.start };
  let memory: LocalMemory | undefined = createLocalMemory({ path, workspaceId: WORKSPACE, agentId: AGENT, retrieval: 'lexical', now: () => new Date(clock.value) });
  try {
    const ids = applyPlan(memory, plan, clock);
    const { headline } = plan;
    say(`Seeded a synthetic project history: ${ids.total} records about ${plan.facts.length} services, ${day(plan.boundaries[0])} to ${day(plan.boundaries[plan.boundaries.length - 1])}.`);
    say('Some facts were learned late (knownAt after validFrom), one belief was later corrected.');
    clock.value = plan.bounds.end;

    const past = { asOf: iso(headline.questionAt), knownAt: iso(headline.questionAt) };
    say('');
    say(`> What did you believe on ${day(headline.questionAt)} about the payments API rate limit?`);
    const then = memory.recall({ query: headline.query, limit: 1, ...past })[0]?.memory;
    say(`  "${then?.text ?? '(nothing)'}"`);
    if (then) say(`  source ${then.source.uri}${then.source.revision ? ` (${then.source.revision})` : ''}, recorded ${day(Date.parse(then.createdAt))}`);
    const today = { asOf: iso(plan.bounds.end), knownAt: iso(plan.bounds.end) };
    const nowBelief = memory.recall({ query: headline.query, limit: 1, ...today })[0]?.memory;
    say('> And now?');
    say(`  "${nowBelief?.text ?? '(nothing)'}"`);

    say('> What changed it?');
    const diff = replayDiff(memory, past, today);
    const added = diff.added.find((record) => record.id === ids.after);
    const removed = diff.removed.find((record) => record.id === ids.before);
    const correction = added?.ledger.find((entry) => entry.event === 'correction');
    if (removed) say(`  - ${removed.text}`);
    if (added) say(`  + ${added.text}`);
    if (added) say(`    source ${added.source.uri} (${added.source.author ?? 'no author'}), valid from ${day(Date.parse(added.validFrom ?? added.createdAt))}`);
    if (correction?.correction) say(`    ledger #${correction.sequence} correction, ${day(Date.parse(correction.recordedAt))}: "${correction.correction.reason}"`);
    say(`  (the whole diff ${day(headline.questionAt)} -> now: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed; state ${diff.from.stateSha256.slice(0, 12)}... -> ${diff.to.stateSha256.slice(0, 12)}...)`);
    const headlineCorrect = then?.id === ids.before && then.text === headline.before.text && nowBelief?.id === ids.after && nowBelief.text === headline.after.text
      && removed !== undefined && added !== undefined && correction?.correction?.reason === headline.after.reason;

    say('');
    const cuts = randomCutPoints(plan, context.cutPoints, context.seed);
    say(`Replaying the belief state at ${cuts.length} random (asOf, knownAt) cut points, twice...`);
    let truthChecked = 0, truthMatched = 0;
    const first = cuts.map((cut) => {
      const state = replayState(memory!, cut, { records: true });
      const asOf = Date.parse(cut.asOf), knownAt = Date.parse(cut.knownAt);
      const byEntity = new Map<string, string[]>();
      for (const record of state.items ?? []) {
        const entity = record.metadata.entity;
        if (typeof entity === 'string') byEntity.set(entity, [...(byEntity.get(entity) ?? []), record.text]);
      }
      for (const fact of plan.facts) {
        const expected = expectedVersionAt(fact, asOf, knownAt);
        const actual = byEntity.get(fact.entity) ?? [];
        truthChecked++;
        if (expected === null ? actual.length === 0 : actual.length === 1 && actual[0] === expected.text) truthMatched++;
      }
      return state.stateSha256;
    });
    memory.close();
    memory = undefined;
    const second = hashesElsewhere(path, cuts);
    const identical = first.filter((hash, index) => hash === second.hashes[index]).length;
    const distinct = new Set(first).size;
    say(`  pass 1: this process, live connection   pass 2: ${second.mode}, cold open of the same file`);
    say(`  ${identical}/${cuts.length} state hashes identical (${distinct} distinct belief states among them)`);
    say(`  ${truthMatched}/${truthChecked} as-of answers match the seeded ground truth (computed from the plan, not the store)`);
    // A corpus whose every cut point hashes the same would pass trivially; demand real variety.
    const passed = headlineCorrect && second.hashes.length === cuts.length && identical === cuts.length && distinct > Math.min(10, cuts.length / 2) && truthMatched === truthChecked;
    return {
      proof: { label: 'replay determinism', measured: `${identical}/${cuts.length} identical, ${truthMatched}/${truthChecked} as-of answers = ground truth`, threshold: 'N/N identical stateSha256 in two readers, every as-of answer = ground truth', passed },
      details: { records: ids.total, cutPoints: cuts.length, identical, distinctStates: distinct, secondPass: second.mode, groundTruth: { checked: truthChecked, matched: truthMatched }, headlineCorrect },
    };
  } finally {
    memory?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
