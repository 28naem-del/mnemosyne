/**
 * Moment 3 — "It found the belief that made it wrong."
 *
 * A task that used to succeed (the agent read the right port from memory) starts
 * failing after one confident, false record arrives through an ordinary channel.
 * One call to the kernel's `bisect` delta-debugs the store down to the record to
 * blame, with no model in the verifier: the outcome is "is the gold evidence in
 * the top-k", which is deterministic.
 *
 * Proof (measured live): blame precision — the culprit set bisect returns equals
 * the seeded record — and time-to-locate in seconds, on a store of at least 2000
 * records. Bisect's own Oracle B re-executes the real recall without the blame
 * set to confirm it, so `exactConfirmed` is part of the pass condition.
 */
import { performance } from 'node:perf_hooks';
import { createLocalMemory } from '../../local/index.js';
import { bisect, type BisectTask } from '../../local/bisect.js';
import { buildOpsCorpus, day, iso } from './corpus.js';
import type { MomentContext, MomentOutcome } from './types.js';

const MINUTE = 60_000;
const START = Date.UTC(2025, 0, 6, 8);

/** The answer the agent would act on: the first port number in its top memory. */
const portIn = (text: string | undefined): string | null => /port (\d+)/.exec(text ?? '')?.[1] ?? null;

export function momentBisect(context: MomentContext): MomentOutcome {
  const { say } = context;
  const corpus = buildOpsCorpus(context.seed, context.records);
  const clock = { value: START };
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'demo-orion', agentId: 'operator', retrieval: 'lexical', now: () => new Date(clock.value) });
  try {
    let goldId = '', poisonId = '', goodUntil = '';
    memory.atomic(() => {
      corpus.filler.forEach((entry, index) => {
        clock.value += MINUTE;
        memory.store({ text: entry.text, kind: entry.kind, trust: 'observed', source: { uri: `synthetic://orion/ops/${index}`, author: `engineer-${index % 17}` } });
        if (index === corpus.goldAfter) {
          clock.value += MINUTE;
          goldId = memory.store({ text: corpus.gold.text, kind: 'fact', trust: 'verified', evidence: corpus.gold.evidence, source: corpus.gold.source }).id;
        }
        if (index === corpus.poisonAfter) {
          goodUntil = iso(clock.value);
          clock.value += MINUTE;
          // Same trust as the corpus around it. An `untrusted` record never enters
          // default recall at all, so injecting one would win without measuring anything.
          poisonId = memory.store({ text: corpus.poison.text, kind: 'fact', trust: 'observed', source: corpus.poison.source }).id;
        }
      });
    });
    clock.value += MINUTE;
    const total = memory.export().memories.length;
    say(`Seeded a synthetic ops store: ${total} records (runbooks, alerts, retros) for the Orion project, one verified deploy manifest among them.`);
    say('');
    say(`> ${corpus.query}?   (asked on ${day(Date.parse(goodUntil))}, before anything went wrong)`);
    const before = memory.recall({ query: corpus.query, limit: 1, knownAt: goodUntil })[0]?.memory;
    say(`  top memory: "${before?.text}"  ->  answer ${portIn(before?.text)}  ok`);
    say('> Same question today:');
    const after = memory.recall({ query: corpus.query, limit: 1 })[0]?.memory;
    const failing = portIn(after?.text) !== portIn(corpus.gold.text);
    say(`  top memory: "${after?.text}"  ->  answer ${portIn(after?.text)}  ${failing ? 'WRONG: the deploy check against port 8443 fails' : 'ok'}`);
    say('');
    say(`> bisect the failure: bisect(memory, { query, k: 1, gold: [manifest] }), the call behind \`mnemosy bisect\`, over ${total} records`);
    const task: BisectTask = { id: 'billing-port', query: corpus.query, k: 1, gold: [goldId], depth: 100 };
    const started = performance.now();
    const result = bisect(memory, task);
    const seconds = (performance.now() - started) / 1000;
    const seeded = new Set([poisonId]);
    const hits = result.blame.filter((id) => seeded.has(id)).length;
    const precision = result.blame.length ? hits / result.blame.length : 0;
    const exact = result.blame.length === seeded.size && hits === seeded.size;
    say(`  outcome ${result.outcome} (${result.reason}): ${result.blame.length} record(s) to blame, ${result.tests} ablation tests over ${result.universe} candidates, gold was rank ${result.goldRank}`);
    for (const id of result.blame) {
      const record = memory.get(id);
      say(`  culprit ${id.slice(0, 8)}... "${record?.text}"`);
      say(`          source ${record?.source.uri} (author ${record?.source.author ?? 'none'}), trust ${record?.trust}, written ${record?.createdAt}`);
    }
    say(`  re-executed recall without it: gold back at rank 1 -> ${result.exactConfirmed ? 'confirmed' : 'NOT confirmed'} (${result.exactRetrieval ?? 'no'} path, no model in the verifier)`);
    say(`  blame precision ${precision.toFixed(2)} (culprit set ${exact ? '==' : '!='} the seeded false record), located in ${seconds.toFixed(2)} s`);
    const passed = failing && before?.id === goldId && total >= 2000 && result.outcome === 'blamed' && exact && result.exactConfirmed === true && seconds < 60;
    return {
      proof: { label: 'blame precision / time-to-locate', measured: `precision ${precision.toFixed(2)}, ${seconds.toFixed(2)} s, ${total} records`, threshold: 'culprit set == seeded record, < 60 s, >= 2000 records', passed },
      details: { records: total, precision, exact, seconds, outcome: result.outcome, blame: result.blame.length, tests: result.tests, universe: result.universe, goldRank: result.goldRank, exactConfirmed: result.exactConfirmed },
    };
  } finally {
    memory.close();
  }
}
