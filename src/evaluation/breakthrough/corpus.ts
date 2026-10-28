/**
 * The demo's bundled synthetic corpora, and the ground truth for them.
 *
 * Everything here is SYNTHETIC and generated from a seed: a fictional project
 * ("Orion") with fictional services, regions and runbooks. Nothing is read from
 * disk or the network, so a fresh clone produces byte-identical stores.
 *
 * Ground truth is computed from the PLAN, never from the store. "The as-of answer
 * matches the seeded ground truth" is therefore a comparison between two
 * independent things, not the kernel agreeing with itself. The temporal rules the
 * plan encodes (half-open validity, knowledge that arrives late) mirror the
 * kernel's documented bitemporal gate, the same rules
 * `tests/fixtures/timeline-corpus.ts` pins for the determinism test.
 */

export const DAY = 86_400_000;
/** The synthetic timeline starts here; the demo never reads a wall clock for kernel time. */
export const DEMO_EPOCH = Date.UTC(2024, 0, 1);

/** mulberry32: small, fast, identical on every engine. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const iso = (millis: number): string => new Date(millis).toISOString();
export const day = (millis: number): string => iso(millis).slice(0, 10);

export interface TimelineVersion {
  /** Real-world validity, half-open: [validFrom, validUntil). */
  validFrom: number;
  validUntil?: number;
  /** Transaction time: when the system learned it. Always >= validFrom. */
  knownFrom: number;
  value: string;
  text: string;
}

export interface TimelineFact { key: string; entity: string; versions: TimelineVersion[] }

/** The one fact moment 1 asks about in plain language: a belief that a correction changed. */
export interface HeadlineFact {
  key: string;
  query: string;
  before: { text: string; at: number; source: { uri: string; author: string; revision: string } };
  after: { text: string; at: number; validFrom: number; source: { uri: string; author: string }; reason: string };
  /** The past date the user asks about: after the first belief, before the correction. */
  questionAt: number;
}

export interface TimelinePlan {
  facts: TimelineFact[];
  headline: HeadlineFact;
  notes: { text: string; createdAt: number }[];
  untrusted: { text: string; createdAt: number }[];
  /** Every instant the plan can change at, ascending. Cut points are biased onto these. */
  boundaries: number[];
  bounds: { start: number; end: number };
}

const REGIONS = ['eu-west-1', 'us-east-2', 'ap-south-1', 'eu-north-1', 'us-west-2', 'ca-central-1', 'sa-east-1', 'af-south-1'];
const SERVICES = ['ledger-api', 'search-indexer', 'auth-gateway', 'invoice-worker', 'media-cdn', 'report-builder', 'notify-hub', 'quota-keeper',
  'audit-sink', 'export-runner', 'pricing-engine', 'session-store', 'webhook-relay', 'catalog-sync', 'feature-flags', 'geo-router',
  'backup-agent', 'metrics-bridge', 'mail-sender', 'tenant-admin', 'cache-warmer', 'schema-registry', 'job-scheduler', 'ingest-edge'];
const TOPICS = ['deployment window', 'retention policy', 'on-call rotation', 'billing cycle', 'index rebuild', 'incident review'];

/**
 * @param entities keyed facts, each with `versions` disjoint validity intervals.
 * Sized so a few hundred cut points replay in well under a second.
 */
export function buildTimelinePlan(seed: number, entities = 24, versions = 4): TimelinePlan {
  const random = seededRandom(seed);
  const facts: TimelineFact[] = [];
  for (let entity = 0; entity < entities; entity++) {
    const name = SERVICES[entity % SERVICES.length] + (entity >= SERVICES.length ? `-${Math.floor(entity / SERVICES.length)}` : '');
    const list: TimelineVersion[] = [];
    let cursor = DEMO_EPOCH + Math.floor(random() * 30) * DAY;
    for (let version = 0; version < versions; version++) {
      const validFrom = cursor;
      cursor = validFrom + (60 + Math.floor(random() * 120)) * DAY;
      // Adjacent versions always differ, so every boundary is a real change of belief.
      const value = REGIONS[(entity + version) % REGIONS.length];
      list.push({
        validFrom,
        ...(version === versions - 1 ? {} : { validUntil: cursor }),
        // Knowledge lags reality by 0, 3 or 17 days: the case where asOf and knownAt disagree.
        knownFrom: validFrom + [0, 3, 17][Math.floor(random() * 3)] * DAY,
        value,
        text: `The Orion ${name} service runs in region ${value}`,
      });
    }
    facts.push({ key: `orion:region:${name}`, entity: name, versions: list });
  }

  const headline: HeadlineFact = {
    key: 'orion:payments-rate-limit',
    query: 'Orion payments API rate limit per tenant',
    before: {
      text: 'The Orion payments API is rate-limited to 100 requests per second per tenant.',
      at: Date.UTC(2024, 2, 4, 9, 30),
      source: { uri: 'synthetic://orion/runbooks/payments.md', author: 'platform-team', revision: 'v1' },
    },
    after: {
      text: 'The Orion payments API is rate-limited to 250 requests per second per tenant, after the June capacity upgrade.',
      at: Date.UTC(2024, 5, 12, 14, 5),
      validFrom: Date.UTC(2024, 5, 10),
      source: { uri: 'synthetic://orion/changes/CHG-2291', author: 'sre-oncall' },
      reason: 'Capacity upgrade CHG-2291 raised the per-tenant limit from 100 to 250 requests per second.',
    },
    questionAt: Date.UTC(2024, 4, 1),
  };

  const notes: TimelinePlan['notes'] = [];
  for (let index = 0; index < 12; index++) {
    notes.push({ text: `Orion note ${String(index).padStart(3, '0')}: the ${TOPICS[index % TOPICS.length]} was reviewed`, createdAt: DEMO_EPOCH + Math.floor(random() * 700) * DAY });
  }
  const untrusted: TimelinePlan['untrusted'] = [];
  for (let index = 0; index < 4; index++) {
    untrusted.push({ text: `Unverified paste ${index}: an unattributed claim about the ${TOPICS[index % TOPICS.length]}`, createdAt: DEMO_EPOCH + Math.floor(random() * 700) * DAY });
  }

  const boundaries = new Set<number>([headline.before.at, headline.after.at, headline.after.validFrom]);
  for (const fact of facts) {
    for (const version of fact.versions) {
      boundaries.add(version.validFrom);
      boundaries.add(version.knownFrom);
      if (version.validUntil !== undefined) boundaries.add(version.validUntil);
    }
  }
  for (const note of [...notes, ...untrusted]) boundaries.add(note.createdAt);
  const ordered = [...boundaries].sort((a, b) => a - b);
  return { facts, headline, notes, untrusted, boundaries: ordered, bounds: { start: ordered[0] - 30 * DAY, end: ordered[ordered.length - 1] + 120 * DAY } };
}

/**
 * GROUND TRUTH: the version the plan says is believed at `(asOf, knownAt)`,
 * computed from the plan alone. `null` means no learned version covers `asOf`.
 */
export function expectedVersionAt(fact: TimelineFact, asOf: number, knownAt: number): TimelineVersion | null {
  const candidates = fact.versions.filter((version) =>
    version.knownFrom <= knownAt && version.validFrom <= asOf && (version.validUntil === undefined || version.validUntil > asOf));
  if (candidates.length > 1) throw new Error(`timeline plan is not disjoint for ${fact.key}`);
  return candidates[0] ?? null;
}

/** Seeded `(asOf, knownAt)` pairs, half of them on or one millisecond beside a plan boundary. */
export function randomCutPoints(plan: TimelinePlan, count: number, seed: number): { asOf: string; knownAt: string }[] {
  const random = seededRandom(seed ^ 0x5eed);
  const span = plan.bounds.end - plan.bounds.start;
  const pick = (): number => {
    const roll = random();
    // Half-open interval edges are where an off-by-one in a temporal predicate shows.
    if (roll < 0.35) return plan.boundaries[Math.floor(random() * plan.boundaries.length)];
    if (roll < 0.5) return plan.boundaries[Math.floor(random() * plan.boundaries.length)] + (random() < 0.5 ? -1 : 1);
    return plan.bounds.start + Math.floor(random() * span);
  };
  return Array.from({ length: count }, () => { const knownAt = pick(); const asOf = pick(); return { asOf: iso(asOf), knownAt: iso(knownAt) }; });
}

/** The bisect moment's store: one true answer, a large ordinary corpus, and one confident false record. */
export interface OpsCorpus {
  query: string;
  gold: { text: string; evidence: string; source: { uri: string; author: string } };
  poison: { text: string; source: { uri: string; author: string } };
  /** Filler records, in write order. */
  filler: { text: string; kind: 'fact' | 'observation' | 'decision' }[];
  /** Index into `filler` after which the gold is written, and after which the poison is. */
  goldAfter: number;
  poisonAfter: number;
}

const FILLER_TOPICS = ['runbook', 'retro', 'alert', 'capacity plan', 'migration', 'dashboard', 'postmortem', 'review'];
const FILLER_FACTS = [
  (svc: string, n: number) => `The Orion ${svc} service keeps ${7 + (n % 23)} days of request logs`,
  (svc: string, n: number) => `Orion ${svc} ${FILLER_TOPICS[n % FILLER_TOPICS.length]} ${n}: latency budget is ${120 + (n % 9) * 10} ms at p99`,
  (svc: string, n: number) => `The ${svc} on-call handoff for Orion happens at ${String(8 + (n % 10)).padStart(2, '0')}:00 UTC`,
  (svc: string, n: number) => `Orion ${svc} uses feature flag set ${n % 41} during the ${FILLER_TOPICS[(n + 3) % FILLER_TOPICS.length]}`,
  (_svc: string, n: number) => `Orion billing cycle ${n} closes on day ${1 + (n % 28)} and invoices are emailed the next morning`,
  (svc: string, n: number) => `Orion ${svc} exposes its health check at /healthz on the internal mesh (note ${n})`,
];

/** @param records total records in the store, gold and poison included. */
export function buildOpsCorpus(seed: number, records: number): OpsCorpus {
  const random = seededRandom(seed ^ 0xb15ec7);
  const filler: OpsCorpus['filler'] = [];
  const kinds = ['fact', 'observation', 'decision'] as const;
  for (let index = 0; index < records - 2; index++) {
    const svc = SERVICES[Math.floor(random() * SERVICES.length)];
    const template = FILLER_FACTS[Math.floor(random() * FILLER_FACTS.length)];
    filler.push({ text: template(svc, index), kind: kinds[Math.floor(random() * kinds.length)] });
  }
  return {
    query: 'Which port does the Orion billing service listen on',
    gold: {
      text: 'The Orion billing service listens on port 8443, as declared in its deploy manifest and checked at the last release',
      evidence: 'synthetic://orion/manifests/billing.yaml#ports, checked by the release pipeline',
      source: { uri: 'synthetic://orion/manifests/billing.yaml', author: 'release-pipeline' },
    },
    poison: {
      text: 'The Orion billing service listens on port 9000',
      source: { uri: 'synthetic://chat/paste-1187', author: 'unknown' },
    },
    filler,
    goldAfter: Math.floor((records - 2) * 0.1),
    poisonAfter: Math.floor((records - 2) * 0.9),
  };
}
