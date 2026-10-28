/**
 * Seeded generator for the synthetic dependency corpus v1.
 *
 * It builds a hidden ground truth (which procedures and skills really rely on
 * which premises without declaring them), decoys that co-occur with dependents
 * without being relied on, and a task stream that reports retrievals, used sets
 * and verdicts the way an agent controller would, with noise: conditional use,
 * attribution dropout, failures, unjudged tasks, incidental and hub co-use.
 * The output is a pure function of the seed and parameters, so the committed
 * corpus can be checked byte for byte against a regeneration.
 */
import { createHash } from 'node:crypto';
import type { CorpusDecoy, CorpusDependent, CorpusParameters, CorpusPremise, CorpusTask, CorpusTrueEdge, DependencyCorpus } from './types.js';

export const DEPENDENCY_CORPUS_SEED = 20261028;
export const DEPENDENCY_CORPUS_GENERATOR = 'dependencies-v1-generator@1';
export const DEFAULT_CORPUS_PARAMETERS: Readonly<CorpusParameters> = Object.freeze({
  facts: 72, decisions: 30, declaringDecisions: 12, preferences: 18, hubs: 4,
  procedures: 84, rareProcedures: 6, rareRuns: 2, skills: 24,
  declaredRate: 0.35, conditionalRate: 0.15, conditionalUsage: [0.6, 0.8], runs: [3, 8],
  failureRate: 0.15, dropoutRate: 0.1, hubRate: 0.04, incidentalRate: 0.25, incidentalUsage: [0.15, 0.25],
  siblingRate: 0.3, recallOnlyRate: 0.08, unjudgedRate: 0.04, verifierShare: 0.3,
} as CorpusParameters);

/** Counter-mode SHA-256: platform independent and stable across Node versions. */
export class SeededRandom {
  readonly #seed: number;
  #counter = 0;
  constructor(seed: number) { this.#seed = seed; }
  next(): number { return createHash('sha256').update(`${this.#seed}:${this.#counter++}`).digest().readUInt32BE(0) / 2 ** 32; }
  chance(probability: number): boolean { return this.next() < probability; }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  uniform(min: number, max: number): number { return Math.round((min + this.next() * (max - min)) * 100) / 100; }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]; }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
      const other = Math.floor(this.next() * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }
}

const SERVICES = ['billing', 'search', 'checkout', 'inventory', 'payments', 'ledger', 'notifications', 'auth', 'gateway', 'catalog', 'shipping', 'analytics', 'reporting', 'scheduler', 'mailer', 'exports', 'imports', 'profiles', 'reviews', 'pricing', 'recommendations', 'media', 'archive', 'audit'];
const STORES = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'granite', 'harbor'];
const TEAMS = ['platform', 'growth', 'core', 'data', 'mobile', 'web', 'infra', 'security'];
const TOOLS = ['ArgoCD', 'Spinnaker', 'Jenkins', 'Buildkite', 'Nomad', 'Tekton'];
const PEOPLE = ['Ana', 'Ben', 'Chen', 'Dara', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jae'];
const HUBS: [string, string][] = [
  ['Preference: all reports use UTC timestamps.', 'Preference: all reports use local office timestamps.'],
  ['Preference: commit messages use the imperative mood.', 'Preference: commit messages use the past tense.'],
  ['Preference: every change links its incident ticket.', 'Preference: changes link a ticket only for incidents above severity two.'],
  ['Preference: summaries stay under five bullet points.', 'Preference: summaries stay under three bullet points.'],
];
const ACTIONS: [string, string, string][] = [
  ['Deploy', 'build the release image', 'shift traffic in two stages'],
  ['Roll back', 'pin the previous image', 'drain the canary pool'],
  ['Migrate', 'snapshot the schema', 'apply migrations in order'],
  ['Back up', 'freeze writes for one minute', 'copy the snapshot offsite'],
  ['Restore', 'fetch the latest snapshot', 'replay the write log'],
  ['Scale', 'raise the replica count', 'rebalance the shards'],
  ['Rotate keys for', 'issue new credentials', 'revoke the old credentials'],
  ['Reindex', 'pause the ingest queue', 'rebuild the index offline'],
  ['Patch', 'apply the security patch', 'restart the workers one by one'],
  ['Audit', 'export the access log', 'compare grants with the policy'],
];

interface Premise extends CorpusPremise { service?: string }

function premises(random: SeededRandom, parameters: CorpusParameters): Premise[] {
  const facts: Premise[] = [];
  const templates = [
    (service: string) => { const port = 7000 + random.int(0, 899) * 3; return [`The ${service} service listens on port ${port}.`, `The ${service} service listens on port ${port + 1}.`]; },
    (service: string) => { const store = random.pick(STORES); const next = STORES[(STORES.indexOf(store) + 1) % STORES.length]; return [`The ${service} service stores its data in the ${store} cluster.`, `The ${service} service stores its data in the ${next} cluster.`]; },
    (service: string) => { const version = random.int(2, 9); return [`The ${service} service requires the ${service}-v${version} feature flag.`, `The ${service} service requires the ${service}-v${version + 1} feature flag.`]; },
  ];
  for (let index = 0; index < parameters.facts; index++) {
    const service = SERVICES[index % SERVICES.length];
    const [text, revision] = templates[Math.floor(index / SERVICES.length) % templates.length](service);
    facts.push({ key: '', kind: 'fact', text, revision, declared: [], hub: false, service });
  }
  const shuffled = random.shuffle(facts).map((fact, index) => ({ ...fact, key: `F${String(index + 1).padStart(3, '0')}` }));
  const decisions: Premise[] = [];
  const used = new Set<string>();
  while (decisions.length < parameters.decisions) {
    const team = random.pick(TEAMS), service = random.pick(SERVICES), tool = random.pick(TOOLS);
    if (used.has(`${team}:${service}`)) continue;
    used.add(`${team}:${service}`);
    const next = TOOLS[(TOOLS.indexOf(tool) + 1) % TOOLS.length];
    const key = `D${String(decisions.length + 1).padStart(3, '0')}`;
    const declared = decisions.length < parameters.declaringDecisions ? [random.pick(shuffled.filter(fact => fact.service === service)).key] : [];
    decisions.push({ key, kind: 'decision', text: `Decision: the ${team} team deploys the ${service} service through ${tool}.`, revision: `Decision: the ${team} team deploys the ${service} service through ${next}.`, declared, hub: false, service });
  }
  const preferences: Premise[] = [];
  for (let index = 0; index < parameters.hubs; index++) {
    const [text, revision] = HUBS[index % HUBS.length];
    preferences.push({ key: `R${String(index + 1).padStart(3, '0')}`, kind: 'preference', text, revision, declared: [], hub: true });
  }
  used.clear();
  while (preferences.length < parameters.preferences) {
    const person = random.pick(PEOPLE), service = random.pick(SERVICES);
    if (used.has(`${person}:${service}`)) continue;
    used.add(`${person}:${service}`);
    const next = PEOPLE[(PEOPLE.indexOf(person) + 1) % PEOPLE.length];
    preferences.push({ key: `R${String(preferences.length + 1).padStart(3, '0')}`, kind: 'preference', text: `Preference: ${person} reviews ${service} changes before release.`, revision: `Preference: ${next} reviews ${service} changes before release.`, declared: [], hub: false, service });
  }
  return [...shuffled.sort((a, b) => a.key.localeCompare(b.key)), ...decisions, ...preferences];
}

/** Generates corpus v1 for `seed`. Parameters default to the committed corpus. */
/** `observabilityFloor: false` drops the floor injection below (same RNG draws,
 * so only the injected co-uses differ); such a corpus is never the gate corpus. */
export function generateDependencyCorpus(seed = DEPENDENCY_CORPUS_SEED, overrides: Partial<CorpusParameters> = {}, options: { observabilityFloor?: boolean } = {}): DependencyCorpus {
  const parameters: CorpusParameters = { ...DEFAULT_CORPUS_PARAMETERS, ...overrides };
  const random = new SeededRandom(seed);
  const all = premises(random, parameters);
  const byKey = new Map(all.map(premise => [premise.key, premise]));
  const pool = all.filter(premise => !premise.hub);
  const hubs = all.filter(premise => premise.hub).map(premise => premise.key);
  const premiseClosure = (keys: string[]) => {
    const seen = new Set<string>(), pending = [...keys];
    while (pending.length) { const key = pending.pop()!; if (seen.has(key)) continue; seen.add(key); pending.push(...byKey.get(key)!.declared); }
    return seen;
  };

  const combos = random.shuffle(ACTIONS.flatMap((action, actionIndex) => SERVICES.map(service => ({ action, actionIndex, service }))));
  const dependents: CorpusDependent[] = [];
  const truth: CorpusTrueEdge[] = [];
  const decoys: CorpusDecoy[] = [];
  const plans: { dependent: CorpusDependent; truth: CorpusTrueEdge[]; failedOnly?: string; sibling?: string; incidental?: { premise: string; usage: number }; unused: string[] }[] = [];
  const total = parameters.procedures + parameters.skills;
  for (let index = 0; index < total; index++) {
    const { action: [verb, first, second], service } = combos[index % combos.length];
    const skill = index >= parameters.procedures;
    const key = skill ? `S${String(index - parameters.procedures + 1).padStart(3, '0')}` : `P${String(index + 1).padStart(3, '0')}`;
    const rare = !skill && index >= parameters.procedures - parameters.rareProcedures;
    const local = pool.filter(premise => premise.service === service);
    const pickPremise = (exclude: Set<string>, preferLocal: number, kinds?: string[]) => {
      const eligible = (list: Premise[]) => list.filter(premise => !exclude.has(premise.key) && (!kinds || kinds.includes(premise.kind)));
      const near = eligible(local), far = eligible(pool);
      if (near.length && random.chance(preferLocal)) return random.pick(near).key;
      return far.length ? random.pick(far).key : undefined;
    };
    const declared: string[] = [];
    if (skill) {
      const count = random.int(1, 2);
      for (let item = 0; item < count; item++) { const premise = pickPremise(new Set(declared), 0.7, ['fact']); if (premise) declared.push(premise); }
    } else if (random.chance(parameters.declaredRate)) {
      const premise = pickPremise(new Set(), 0.6, ['fact', 'decision']);
      if (premise) declared.push(premise);
    }
    const blocked = premiseClosure(declared);
    const relied: CorpusTrueEdge[] = [];
    const count = skill ? (random.chance(0.6) ? 1 : 2) : random.pick([1, 1, 1, 2, 2, 3]);
    for (let item = 0; item < count; item++) {
      const premise = pickPremise(new Set([...blocked, ...relied.map(edge => edge.premise)]), 0.5);
      if (!premise) continue;
      const usage = random.chance(parameters.conditionalRate) ? random.uniform(...parameters.conditionalUsage) : 1;
      relied.push({ dependent: key, premise, usage });
    }
    const trueClosure = premiseClosure([...declared, ...relied.map(edge => edge.premise)]);
    const taken = new Set(trueClosure);
    const take = (preferLocal: number) => { const premise = pickPremise(taken, preferLocal); if (premise) taken.add(premise); return premise; };
    const unused: string[] = [];
    const unusedCount = random.int(1, 3);
    for (let item = 0; item < unusedCount; item++) { const premise = take(0.6); if (premise) unused.push(premise); }
    const failedOnly = random.chance(0.5) ? take(0.3) : undefined;
    const sibling = random.chance(parameters.siblingRate) ? (() => {
      const services = new Set(relied.map(edge => byKey.get(edge.premise)!.service).filter(Boolean));
      const near = pool.filter(premise => premise.kind === 'fact' && services.has(premise.service) && !taken.has(premise.key));
      if (!near.length) return undefined;
      const premise = random.pick(near).key; taken.add(premise); return premise;
    })() : undefined;
    const incidental = random.chance(parameters.incidentalRate) ? (() => { const premise = take(0.4); return premise ? { premise, usage: random.uniform(...parameters.incidentalUsage) } : undefined; })() : undefined;
    const steps = [`${first[0].toUpperCase()}${first.slice(1)}`, `${second[0].toUpperCase()}${second.slice(1)}`];
    const text = skill ? `${verb} ${service}: ${steps.join('; ')}.` : `Procedure: ${verb.toLowerCase()} the ${service} service: ${first}, then ${second}.`;
    const dependent: CorpusDependent = { key, type: skill ? 'skill' : 'procedure', text, ...(skill ? { skill: { name: `${verb} ${service}`, steps } } : {}), declared, runs: rare ? parameters.rareRuns : random.int(...parameters.runs) };
    dependents.push(dependent);
    truth.push(...relied);
    unused.forEach(premise => decoys.push({ dependent: key, premise, class: 'retrieved-unused' }));
    if (failedOnly) decoys.push({ dependent: key, premise: failedOnly, class: 'failed-only' });
    if (sibling) decoys.push({ dependent: key, premise: sibling, class: 'sibling' });
    if (incidental) decoys.push({ dependent: key, premise: incidental.premise, class: 'incidental' });
    plans.push({ dependent, truth: relied, unused, ...(failedOnly ? { failedOnly } : {}), ...(sibling ? { sibling } : {}), ...(incidental ? { incidental } : {}) });
  }

  const tasks: Omit<CorpusTask, 'id'>[] = [];
  const hubUse = new Set<string>();
  for (const plan of plans) {
    const { dependent } = plan;
    const own: Omit<CorpusTask, 'id'>[] = [];
    for (let run = 0; run < dependent.runs; run++) {
      const used = new Set<string>([dependent.key]);
      for (const premise of dependent.declared) if (random.chance(0.9)) used.add(premise);
      for (const edge of plan.truth) if (random.chance(edge.usage)) used.add(edge.premise);
      if (plan.incidental && random.chance(plan.incidental.usage)) used.add(plan.incidental.premise);
      for (const hub of hubs) if (random.chance(parameters.hubRate)) used.add(hub);
      const retrieved = new Set([...used, ...plan.unused, ...(plan.sibling ? [plan.sibling] : []), ...(plan.failedOnly && random.chance(0.5) ? [plan.failedOnly] : [])]);
      // Attribution dropout: the controller used a premise but did not report it.
      const reported = [...used].filter(key => key === dependent.key || !random.chance(parameters.dropoutRate));
      const judge = random.chance(parameters.unjudgedRate) ? 'none' : random.chance(parameters.verifierShare) ? 'verifier' : 'trace';
      own.push({ dependent: dependent.key, mode: 'trace', query: dependent.text, retrieved: [...retrieved], used: reported, success: true, judge });
      if (random.chance(parameters.failureRate)) {
        const failedUsed = new Set<string>([dependent.key, ...(plan.failedOnly ? [plan.failedOnly] : []), ...(plan.sibling ? [plan.sibling] : [])]);
        for (const edge of plan.truth) if (random.chance(0.5)) failedUsed.add(edge.premise);
        own.push({ dependent: dependent.key, mode: 'trace', query: dependent.text, retrieved: [...new Set([...failedUsed, ...plan.unused])], used: [...failedUsed], success: false, judge: 'verifier' });
      }
      if (random.chance(parameters.recallOnlyRate)) {
        const premise = plan.truth[0] ? byKey.get(plan.truth[0].premise)!.text : '';
        own.push({ dependent: dependent.key, mode: 'recall-only', query: `${dependent.text} ${premise}`.trim(), retrieved: [], used: [], success: true, judge: 'verifier' });
      }
    }
    // Observability floor: every true dependency appears in at least one judged
    // successful used set. A reliance no task ever reports is invisible to any
    // co-use method, and this is also exactly what the premise guard needs to
    // hold a pair. docs/DEPENDENCIES.md, "The observability floor", states it
    // and its measured effect (cli.js --seed N --no-floor reproduces it).
    const judged = own.filter(task => task.mode === 'trace' && task.success && task.judge !== 'none');
    if (!judged.length) {
      const first = own.find(task => task.mode === 'trace' && task.success)!;
      first.judge = 'trace';
      judged.push(first);
    }
    for (const edge of options.observabilityFloor === false ? [] : plan.truth) {
      if (judged.some(task => task.used.includes(edge.premise))) continue;
      const target = judged[0];
      target.used = [...target.used, edge.premise];
      if (!target.retrieved.includes(edge.premise)) target.retrieved = [...target.retrieved, edge.premise];
    }
    for (const task of own) {
      task.retrieved = sortKeys(task.retrieved, dependent.key);
      task.used = sortKeys(task.used, dependent.key);
      if (task.mode === 'trace' && task.success) for (const hub of hubs) if (task.used.includes(hub)) hubUse.add(`${dependent.key}\u0000${hub}`);
    }
    tasks.push(...own);
  }
  for (const pair of [...hubUse].sort()) {
    const [dependent, premise] = pair.split('\u0000');
    decoys.push({ dependent, premise, class: 'hub' });
  }
  const ordered = random.shuffle(tasks).map((task, index) => ({ id: `T${String(index + 1).padStart(4, '0')}`, ...task }));
  return {
    suite: 'dependencies-v1', synthetic: true, seed, generator: DEPENDENCY_CORPUS_GENERATOR, parameters,
    premises: all.map(({ service: _service, ...premise }) => premise),
    dependents,
    truth: truth.sort((a, b) => a.dependent.localeCompare(b.dependent) || a.premise.localeCompare(b.premise)),
    decoys: decoys.sort((a, b) => a.dependent.localeCompare(b.dependent) || a.premise.localeCompare(b.premise) || a.class.localeCompare(b.class)),
    tasks: ordered,
  };
}

/** The dependent first, then premises by key: a stable, readable order. */
function sortKeys(keys: string[], dependent: string): string[] {
  return [dependent, ...[...new Set(keys)].filter(key => key !== dependent).sort()].filter(key => keys.includes(key));
}

/** One array element per line: diffable, valid JSON, byte-stable. */
export function serializeDependencyCorpus(corpus: DependencyCorpus): string {
  const lines = ['{'];
  const entries = Object.entries(corpus);
  entries.forEach(([key, value], index) => {
    const comma = index < entries.length - 1 ? ',' : '';
    if (Array.isArray(value)) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((item, itemIndex) => lines.push(`    ${JSON.stringify(item)}${itemIndex < value.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function corpusSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
